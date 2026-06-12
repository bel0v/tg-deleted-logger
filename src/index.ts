import { Api, TelegramClient } from "telegram"
import {
	DeletedMessage,
	type DeletedMessageEvent,
} from "telegram/events/DeletedMessage.js"
import {
	EditedMessage,
	type EditedMessageEvent,
} from "telegram/events/EditedMessage.js"
import type { NewMessageEvent } from "telegram/events/index.js"
import { NewMessage } from "telegram/events/index.js"
import { StringSession } from "telegram/sessions/index.js"

import { loadConfig } from "./config.ts"
import { insertMessage, markDeleted, recordEdit } from "./db.ts"
import { logger } from "./logger.ts"

async function main(): Promise<void> {
	const config = loadConfig()
	const client = new TelegramClient(
		new StringSession(config.session),
		config.apiId,
		config.apiHash,
		{ connectionRetries: 5 },
	)

	await client.connect()
	logger.info("connected")

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
			logger.info(
				{ event: "new", chat: chatId, id: msg.id, stored: inserted },
				"new message",
			)
		},
		new NewMessage({ incoming: true }),
	)

	client.addEventHandler(
		(event: EditedMessageEvent) => {
			const msg = event.message
			const chatId = msg.chatId?.toString() ?? "unknown"
			const outcome = recordEdit({
				chat_id: chatId,
				msg_id: msg.id,
				sender_id: msg.senderId?.toString() ?? null,
				text: msg.message || null,
				media_kind: msg.media?.className ?? null,
				observed_at: Date.now(),
			})
			logger.info(
				{ event: "edit", chat: chatId, id: msg.id, outcome },
				"edited message",
			)
		},
		new EditedMessage({ incoming: true }),
	)

	client.addEventHandler((event: DeletedMessageEvent) => {
		const results = markDeleted(event.deletedIds, Date.now())
		for (const r of results) {
			logger.info(
				{ event: "delete", id: r.msg_id, matched: r.matched },
				r.matched ? "deletion marked" : "deletion without prior message",
			)
		}
	}, new DeletedMessage({}))

	const shutdown = async (signal: string): Promise<void> => {
		logger.info({ signal }, "shutdown")
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
	logger.fatal({ err }, "main loop crashed")
	process.exit(1)
})
