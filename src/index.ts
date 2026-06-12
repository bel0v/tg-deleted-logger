import { Api, TelegramClient } from "telegram"
import {
	DeletedMessage,
	type DeletedMessageEvent,
} from "telegram/events/DeletedMessage.js"
import type { NewMessageEvent } from "telegram/events/index.js"
import { NewMessage } from "telegram/events/index.js"
import { StringSession } from "telegram/sessions/index.js"

import { loadConfig } from "./config.js"
import { insertMessage, markDeleted } from "./db.js"

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
			const chatId = msg.chatId?.toString() ?? "unknown"
			const inserted = insertMessage({
				chat_id: chatId,
				msg_id: msg.id,
				sender_id: msg.senderId?.toString() ?? null,
				text: msg.message || null,
				media_kind: msg.media?.className ?? null,
				received_at: Date.now(),
			})
			console.log(`[new] chat=${chatId} id=${msg.id} stored=${inserted}`)
		},
		new NewMessage({ incoming: true }),
	)

	client.addEventHandler((event: DeletedMessageEvent) => {
		const results = markDeleted(event.deletedIds, Date.now())
		for (const r of results) {
			console.log(
				`[del] id=${r.msg_id} ${r.matched ? "marked" : "no-match (was offline?)"}`,
			)
		}
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
