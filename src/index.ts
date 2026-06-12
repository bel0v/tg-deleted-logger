import { Api, TelegramClient } from "telegram"
import {
	DeletedMessage,
	type DeletedMessageEvent,
} from "telegram/events/DeletedMessage.js"
import type { NewMessageEvent } from "telegram/events/index.js"
import { NewMessage } from "telegram/events/index.js"
import { StringSession } from "telegram/sessions/index.js"

import { loadConfig } from "./config.js"

async function main(): Promise<void> {
	const config = loadConfig()
	const client = new TelegramClient(
		new StringSession(config.session),
		config.apiId,
		config.apiHash,
		{ connectionRetries: 5 },
	)

	await client.connect()
	console.log("[boot] connected")

	await client.invoke(new Api.account.UpdateStatus({ offline: true }))

	client.addEventHandler(
		(event: NewMessageEvent) => {
			const msg = event.message
			console.log(`[new] chat=${String(msg.chatId)} id=${msg.id}`)
			// TODO: layer 1 — persist to SQLite
		},
		new NewMessage({ incoming: true }),
	)

	client.addEventHandler((event: DeletedMessageEvent) => {
		console.log(`[del] ids=${event.deletedIds.join(",")}`)
		// TODO: layer 1 — mark rows deleted in SQLite
	}, new DeletedMessage({}))

	const shutdown = async (signal: string): Promise<void> => {
		console.log(`[shutdown] received ${signal}`)
		await client.disconnect()
		process.exit(0)
	}
	process.on("SIGINT", () => {
		void shutdown("SIGINT")
	})
	process.on("SIGTERM", () => {
		void shutdown("SIGTERM")
	})
}

main().catch((err: unknown) => {
	console.error("[fatal]", err)
	process.exit(1)
})
