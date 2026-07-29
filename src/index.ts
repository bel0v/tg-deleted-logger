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
import { type CacheApi, createCache, displayName } from "./cache.ts"
import { loadConfig } from "./config.ts"
import {
	DEFAULT_RECONCILE_INTERVAL_MS,
	MIN_RECONCILE_INTERVAL_MS,
	WATCHDOG_INTERVAL_MS,
	WATCHDOG_MAX_FAILURES,
	WATCHDOG_PROBE_TIMEOUT_MS,
} from "./constants.ts"
import { createLogger, type Logger } from "./logger.ts"
import { downloadMessageMedia, isViewOnce, shouldDownload } from "./media.ts"
import { createNotifier, type Notifier } from "./notifier.ts"
import { startReconcileLoop } from "./reconciler.ts"
import { startRetentionLoop } from "./retention.ts"
import { registerShutdown } from "./shutdown.ts"
import { startWatchdog } from "./watchdog.ts"

const DEFAULT_MEDIA_DIR = "data/media"
const DEFAULT_NOTIFY_TARGET = "me"

interface SenderResolveDeps {
	cache: CacheApi
	logger: Logger
}

function rememberSender(cache: CacheApi, user: Api.User): string {
	const identity = {
		username: user.username ?? null,
		first_name: user.firstName ?? null,
		last_name: user.lastName ?? null,
	}
	cache.upsertUser({ user_id: user.id.toString(), ...identity })
	return displayName(identity)
}

/**
 * Returns a display name and upserts the user into the cache. Awaits
 * `msg.getSender()` if neither GramJS's update entity nor our local cache
 * knows about this sender yet — that means edit/delete events for the same
 * message will have a populated name in the snapshot.
 */
async function upsertAndDisplaySender(
	deps: SenderResolveDeps,
	msg: Api.Message,
): Promise<string> {
	const { cache, logger } = deps

	// Fast path: GramJS already attached the entity to the update.
	if (msg.sender instanceof Api.User) {
		return rememberSender(cache, msg.sender)
	}

	const senderId = msg.senderId?.toString() ?? null
	if (!senderId) return "(unknown)"

	// We've seen this user before — use what we have, no RPC.
	const cached = cache.getUserById(senderId)
	if (cached) return displayName(cached)

	// First time meeting this contact and GramJS doesn't have them yet.
	// Block until Telegram tells us who they are.
	try {
		const resolved = await msg.getSender()
		if (resolved instanceof Api.User) {
			return rememberSender(cache, resolved)
		}
	} catch (err) {
		logger.warn({ senderId, err }, "sender resolve failed")
	}
	return "(unknown)"
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
		async (event: NewMessageEvent) => {
			if (event.isPrivate !== true) return
			const msg = event.message
			const chatId = msg.chatId?.toString()
			if (!chatId) {
				logger.warn({ id: msg.id }, "new message without chatId, skipping")
				return
			}
			const from = await upsertAndDisplaySender({ cache, logger }, msg)

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
		async (event: EditedMessageEvent) => {
			if (event.isPrivate !== true) return
			const msg = event.message
			const chatId = msg.chatId?.toString()
			if (!chatId) {
				logger.warn({ id: msg.id }, "edited message without chatId, skipping")
				return
			}
			const from = await upsertAndDisplaySender({ cache, logger }, msg)

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
	const stopWatchdog = startWatchdog({
		client,
		logger,
		intervalMs: WATCHDOG_INTERVAL_MS,
		probeTimeoutMs: WATCHDOG_PROBE_TIMEOUT_MS,
		maxFailures: WATCHDOG_MAX_FAILURES,
		onDead: () => process.exit(1),
	})

	registerShutdown({
		logger,
		stopReconcile,
		stopRetention,
		stopWatchdog,
		client,
	})
}

main().catch((err: unknown) => {
	console.error("[fatal]", err)
	process.exit(1)
})
