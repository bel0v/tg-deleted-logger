import type { TelegramClient } from "telegram"
import { FloodWaitError } from "telegram/errors/index.js"

import type { DbApi } from "./db.ts"
import type { Logger } from "./logger.ts"

const BATCH_SIZE = 100

// GramJS types getMessages's return as Api.Message[], but at runtime Telegram
// returns Api.MessageEmpty (className === "MessageEmpty") for any ID that no
// longer exists on the server. This predicate is the single place we trust
// that runtime quirk.
export function isMessageEmpty(msg: unknown): boolean {
	if (msg === null || msg === undefined) return true
	return (
		typeof msg === "object" &&
		"className" in msg &&
		msg.className === "MessageEmpty"
	)
}

export interface ReconcileOptions {
	client: TelegramClient
	db: DbApi
	logger: Logger
	intervalMs: number
}

async function reconcileChat(
	deps: { client: TelegramClient; db: DbApi; logger: Logger },
	chatId: string,
	signal: AbortSignal,
): Promise<void> {
	const { client, db, logger } = deps

	const liveIds = db.listLiveMessageIds(chatId)
	if (liveIds.length === 0) return

	const peerId = Number(chatId)
	if (!Number.isSafeInteger(peerId)) {
		logger.warn({ chat: chatId }, "chat id outside safe integer range, skip")
		return
	}

	const missing: number[] = []

	for (let i = 0; i < liveIds.length; i += BATCH_SIZE) {
		if (signal.aborted) {
			logger.info({ chat: chatId, scanned: i }, "chat reconcile aborted")
			return
		}
		const batch = liveIds.slice(i, i + BATCH_SIZE)
		const messages = await client.getMessages(peerId, { ids: batch })

		for (let j = 0; j < batch.length; j++) {
			const msgId = batch[j]
			if (msgId !== undefined && isMessageEmpty(messages[j])) {
				missing.push(msgId)
			}
		}
	}

	if (missing.length === 0) return

	const results = db.markDeleted(missing, Date.now())
	for (const r of results) {
		if (r.matched) {
			logger.info(
				{ event: "delete", id: r.msg_id, chat: chatId, via: "reconcile" },
				"silent deletion detected",
			)
		}
	}
}

async function reconcileOnce(
	deps: { client: TelegramClient; db: DbApi; logger: Logger },
	signal: AbortSignal,
): Promise<void> {
	const { db, logger } = deps
	const chats = db.listChatsWithLiveMessages()
	logger.debug({ chats: chats.length }, "reconcile pass start")

	for (const chatId of chats) {
		if (signal.aborted) {
			logger.info("reconcile pass aborted")
			return
		}
		try {
			await reconcileChat(deps, chatId, signal)
		} catch (err) {
			if (err instanceof FloodWaitError) {
				logger.warn(
					{ chat: chatId, waitSeconds: err.seconds },
					"FloodWait — ending reconcile pass early; next interval will retry",
				)
				return
			}
			logger.warn({ chat: chatId, err }, "reconcile chat failed")
		}
	}
}

export function startReconcileLoop(
	opts: ReconcileOptions,
): () => Promise<void> {
	const { client, db, logger, intervalMs } = opts
	const deps = { client, db, logger }
	const controller = new AbortController()
	let inFlight: Promise<void> | null = null

	const tick = (): void => {
		if (controller.signal.aborted || inFlight) return
		inFlight = reconcileOnce(deps, controller.signal)
			.catch((err: unknown) => {
				logger.error({ err }, "reconcile pass failed")
			})
			.finally(() => {
				inFlight = null
			})
	}

	tick()
	const handle = setInterval(tick, intervalMs)

	return async (): Promise<void> => {
		controller.abort()
		clearInterval(handle)
		if (inFlight) await inFlight
	}
}
