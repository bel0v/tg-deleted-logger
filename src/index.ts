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
import { type CacheApi, createCache, displayName } from "./cache.ts"
import { loadConfig } from "./config.ts"
import {
	DEFAULT_RECONCILE_INTERVAL_MS,
	MIN_RECONCILE_INTERVAL_MS,
} from "./constants.ts"
import { createLogger, type Logger } from "./logger.ts"
import { downloadMessageMedia, isViewOnce, shouldDownload } from "./media.ts"
import { startReconcileLoop } from "./reconciler.ts"
import { startRetentionLoop } from "./retention.ts"
import { registerShutdown } from "./shutdown.ts"

const DEFAULT_MEDIA_DIR = "data/media"

function upsertAndDisplaySender(
	cache: CacheApi,
	sender: Entity | undefined,
): string {
	if (!(sender instanceof Api.User)) return "(unknown)"
	const identity = {
		username: sender.username ?? null,
		first_name: sender.firstName ?? null,
		last_name: sender.lastName ?? null,
	}
	cache.upsertUser({
		user_id: sender.id.toString(),
		...identity,
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

interface HandlerDeps {
	client: TelegramClient
	cache: CacheApi
	logger: Logger
	mediaDir: string
}

function registerHandlers(deps: HandlerDeps): void {
	const { client, cache, logger, mediaDir } = deps

	client.addEventHandler(
		(event: NewMessageEvent) => {
			const msg = event.message
			const chatId = msg.chatId?.toString() ?? "unknown"
			const from = upsertAndDisplaySender(cache, msg.sender)

			const inserted = cache.insertMessage({
				chat_id: chatId,
				msg_id: msg.id,
				sender_id: msg.senderId?.toString() ?? null,
				text: msg.message || null,
				media_kind: msg.media?.className ?? null,
				view_once: isViewOnce(msg),
				sent_at: msg.date ? msg.date * 1000 : null,
				received_at: Date.now(),
			})
			logger.info(
				{ event: "new", chat: chatId, id: msg.id, from, stored: inserted },
				"new message",
			)

			if (inserted && shouldDownload(msg.media)) {
				downloadMessageMedia({ client, message: msg, mediaDir })
					.then((filename) => {
						if (filename) {
							cache.setMediaPath(chatId, msg.id, filename)
							logger.info(
								{ event: "media", id: msg.id, filename },
								"media downloaded",
							)
						}
					})
					.catch((err: unknown) => {
						logger.warn({ id: msg.id, err }, "media download failed")
					})
			}
		},
		new NewMessage({ incoming: true }),
	)

	client.addEventHandler(
		(event: EditedMessageEvent) => {
			const msg = event.message
			const chatId = msg.chatId?.toString() ?? "unknown"
			const from = upsertAndDisplaySender(cache, msg.sender)

			const outcome = cache.recordEdit({
				chat_id: chatId,
				msg_id: msg.id,
				sender_id: msg.senderId?.toString() ?? null,
				text: msg.message || null,
				media_kind: msg.media?.className ?? null,
				view_once: false,
				sent_at: msg.date ? msg.date * 1000 : null,
				observed_at: Date.now(),
			})
			logger.info(
				{
					event: "edit",
					chat: chatId,
					id: msg.id,
					from,
					outcome: outcome.kind,
				},
				"edited message",
			)
		},
		new EditedMessage({ incoming: true }),
	)

	client.addEventHandler((event: DeletedMessageEvent) => {
		const results = cache.markDeleted(event.deletedIds, Date.now())
		for (const r of results) {
			const snapshot = r.matched ? cache.getMessage(r.msg_id) : undefined
			const from = snapshot?.sender ? displayName(snapshot.sender) : "(unknown)"
			logger.info(
				{ event: "delete", id: r.msg_id, matched: r.matched, from },
				r.matched ? "deletion marked" : "deletion without prior message",
			)
		}
	}, new DeletedMessage({}))
}

async function main(): Promise<void> {
	const config = loadConfig()
	const logger = createLogger()
	const cache = createCache()

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

	const mediaDir = process.env.TG_MEDIA_DIR ?? DEFAULT_MEDIA_DIR
	registerHandlers({ client, cache, logger, mediaDir })

	const reconcileIntervalMs = parseIntervalMs(
		process.env.TG_RECONCILE_INTERVAL_MS,
		logger,
	)
	const stopReconcile = startReconcileLoop({
		client,
		cache,
		logger,
		intervalMs: reconcileIntervalMs,
	})
	const stopRetention = startRetentionLoop({ logger, cache, mediaDir })

	registerShutdown({ logger, stopReconcile, stopRetention, client })
}

main().catch((err: unknown) => {
	console.error("[fatal]", err)
	process.exit(1)
})
