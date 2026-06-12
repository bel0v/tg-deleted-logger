import { Api, TelegramClient } from "telegram"
import type { Entity } from "telegram/define.js"
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
import { createDb, type DbApi, displayName } from "./db.ts"
import { createLogger, type Logger } from "./logger.ts"
import { startReconcileLoop } from "./reconciler.ts"

const DEFAULT_RECONCILE_INTERVAL_MS = 10 * 60 * 1000
const MIN_RECONCILE_INTERVAL_MS = 1000
const SHUTDOWN_TIMEOUT_MS = 10_000

function recordSender(db: DbApi, sender: Entity | undefined): string {
	if (!(sender instanceof Api.User)) return "(unknown)"
	const identity = {
		username: sender.username ?? null,
		first_name: sender.firstName ?? null,
		last_name: sender.lastName ?? null,
	}
	db.upsertUser({
		user_id: sender.id.toString(),
		...identity,
		updated_at: Date.now(),
	})
	return displayName(identity)
}

function parseIntervalMs(raw: string | undefined, logger: Logger): number {
	if (raw === undefined) {
		return DEFAULT_RECONCILE_INTERVAL_MS
	}
	const parsed = Number(raw)
	if (!Number.isFinite(parsed) || parsed < MIN_RECONCILE_INTERVAL_MS) {
		logger.warn(
			{ raw, fallback: DEFAULT_RECONCILE_INTERVAL_MS },
			"TG_RECONCILE_INTERVAL_MS invalid, using default",
		)
		return DEFAULT_RECONCILE_INTERVAL_MS
	}
	return parsed
}

async function main(): Promise<void> {
	const config = loadConfig()
	const logger = createLogger()
	const db = createDb()

	process.on("uncaughtException", (err: Error) => {
		logger.fatal({ err }, "uncaughtException")
		process.exit(1)
	})
	process.on("unhandledRejection", (reason: unknown) => {
		logger.fatal({ reason }, "unhandledRejection")
		process.exit(1)
	})

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
			const from = recordSender(db, msg.sender)

			const inserted = db.insertMessage({
				chat_id: chatId,
				msg_id: msg.id,
				sender_id: msg.senderId?.toString() ?? null,
				text: msg.message || null,
				media_kind: msg.media?.className ?? null,
				sent_at: msg.date ? msg.date * 1000 : null,
				received_at: Date.now(),
			})
			logger.info(
				{ event: "new", chat: chatId, id: msg.id, from, stored: inserted },
				"new message",
			)
		},
		new NewMessage({ incoming: true }),
	)

	client.addEventHandler(
		(event: EditedMessageEvent) => {
			const msg = event.message
			const chatId = msg.chatId?.toString() ?? "unknown"
			const from = recordSender(db, msg.sender)

			const outcome = db.recordEdit({
				chat_id: chatId,
				msg_id: msg.id,
				sender_id: msg.senderId?.toString() ?? null,
				text: msg.message || null,
				media_kind: msg.media?.className ?? null,
				sent_at: msg.date ? msg.date * 1000 : null,
				observed_at: Date.now(),
			})
			logger.info(
				{ event: "edit", chat: chatId, id: msg.id, from, outcome },
				"edited message",
			)
		},
		new EditedMessage({ incoming: true }),
	)

	client.addEventHandler((event: DeletedMessageEvent) => {
		const results = db.markDeleted(event.deletedIds, Date.now())
		for (const r of results) {
			const sender = r.matched ? db.getMessageSender(r.msg_id) : undefined
			const from = sender ? displayName(sender) : "(unknown)"
			logger.info(
				{ event: "delete", id: r.msg_id, matched: r.matched, from },
				r.matched ? "deletion marked" : "deletion without prior message",
			)
		}
	}, new DeletedMessage({}))

	const intervalMs = parseIntervalMs(
		process.env.TG_RECONCILE_INTERVAL_MS,
		logger,
	)
	const stopReconcile = startReconcileLoop({ client, db, logger, intervalMs })
	logger.info({ intervalMs }, "reconcile loop started")

	let shuttingDown = false
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) {
			logger.warn({ signal }, "shutdown already in progress, ignoring signal")
			return
		}
		shuttingDown = true
		logger.info({ signal }, "shutdown")

		const cleanup = async (): Promise<"ok"> => {
			await stopReconcile()
			await client.disconnect()
			db.close()
			return "ok"
		}

		const timeout = new Promise<"timeout">((resolve) => {
			setTimeout(() => {
				resolve("timeout")
			}, SHUTDOWN_TIMEOUT_MS)
		})

		const winner = await Promise.race([cleanup(), timeout])
		if (winner === "timeout") {
			logger.error(
				{ timeoutMs: SHUTDOWN_TIMEOUT_MS },
				"shutdown timed out, forcing exit",
			)
			process.exit(1)
		}
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
