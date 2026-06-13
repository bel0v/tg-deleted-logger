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
import { createNotifier, type Notifier } from "./notifier.ts"
import { startReconcileLoop } from "./reconciler.ts"
import { startRetentionLoop } from "./retention.ts"
import { registerShutdown } from "./shutdown.ts"

const DEFAULT_MEDIA_DIR = "data/media"
const DEFAULT_NOTIFY_TARGET = "me"

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
	notifier: Notifier
	mediaDir: string
}

function registerHandlers(deps: HandlerDeps): void {
	const { client, cache, logger, notifier, mediaDir } = deps

	client.addEventHandler(
		(event: NewMessageEvent) => {
			if (event.isPrivate !== true) return
			const msg = event.message
			const chatId = msg.chatId?.toString()
			if (!chatId) {
				logger.warn({ id: msg.id }, "new message without chatId, skipping")
				return
			}
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
			if (event.isPrivate !== true) return
			const msg = event.message
			const chatId = msg.chatId?.toString()
			if (!chatId) {
				logger.warn({ id: msg.id }, "edited message without chatId, skipping")
				return
			}
			const from = upsertAndDisplaySender(cache, msg.sender)

			const outcome = cache.recordEdit({
				chat_id: chatId,
				msg_id: msg.id,
				sender_id: msg.senderId?.toString() ?? null,
				text: msg.message || null,
				media_kind: msg.media?.className ?? null,
				view_once: isViewOnce(msg),
				sent_at: msg.date ? msg.date * 1000 : null,
				observed_at: Date.now(),
			})

			// Telegram fires EditedMessage for reactions, pin/unpin, formatting-
			// only changes, etc. — none of which we notify on. Skip the log too
			// so it doesn't bury the actual revisions.
			if (outcome.kind === "no-change") return

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

			if (outcome.kind === "revised") {
				void notifier.notifyEdit({
					msgId: msg.id,
					sender: from,
					before: outcome.before,
					after: msg.message || null,
				})
			}
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
			if (r.matched && snapshot) {
				void notifier.notifyDelete({
					msgId: r.msg_id,
					sender: from,
					snapshot,
					via: "event",
				})
			}
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
	const notifyTarget = process.env.TG_NOTIFY_CHAT_ID ?? DEFAULT_NOTIFY_TARGET
	const notifier = createNotifier({
		client,
		logger,
		target: notifyTarget,
		mediaDir,
	})
	logger.info({ notifyTarget, mediaDir }, "notifier ready")

	registerHandlers({ client, cache, logger, notifier, mediaDir })

	const reconcileIntervalMs = parseIntervalMs(
		process.env.TG_RECONCILE_INTERVAL_MS,
		logger,
	)
	const stopReconcile = startReconcileLoop({
		client,
		cache,
		logger,
		notifier,
		intervalMs: reconcileIntervalMs,
	})
	const stopRetention = startRetentionLoop({ logger, cache, mediaDir })

	registerShutdown({ logger, stopReconcile, stopRetention, client })
}

main().catch((err: unknown) => {
	console.error("[fatal]", err)
	process.exit(1)
})
