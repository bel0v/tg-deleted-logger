import type { TelegramClient } from "telegram"

import {
	listChatsWithLiveMessages,
	listLiveMessageIds,
	markDeleted,
} from "./db.ts"
import { logger } from "./logger.ts"

const BATCH_SIZE = 100

async function reconcileChat(
	client: TelegramClient,
	chatId: string,
): Promise<void> {
	const liveIds = listLiveMessageIds(chatId)
	if (liveIds.length === 0) return

	const peerId = Number(chatId)
	if (!Number.isSafeInteger(peerId)) {
		logger.warn({ chat: chatId }, "chat id outside safe integer range, skip")
		return
	}

	const missing: number[] = []

	for (let i = 0; i < liveIds.length; i += BATCH_SIZE) {
		const batch = liveIds.slice(i, i + BATCH_SIZE)
		const messages = (await client.getMessages(peerId, {
			ids: batch,
		})) as Array<{ className?: string } | undefined>

		for (let j = 0; j < batch.length; j++) {
			const msgId = batch[j]
			const msg = messages[j]
			if (msgId !== undefined && (!msg || msg.className === "MessageEmpty")) {
				missing.push(msgId)
			}
		}
	}

	if (missing.length === 0) return

	const results = markDeleted(missing, Date.now())
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
	client: TelegramClient,
	signal: AbortSignal,
): Promise<void> {
	const chats = listChatsWithLiveMessages()
	logger.debug({ chats: chats.length }, "reconcile pass start")

	for (const chatId of chats) {
		if (signal.aborted) {
			logger.info("reconcile pass aborted")
			return
		}
		try {
			await reconcileChat(client, chatId)
		} catch (err) {
			logger.warn({ chat: chatId, err }, "reconcile chat failed")
		}
	}
}

export function startReconcileLoop(
	client: TelegramClient,
	intervalMs: number,
): () => Promise<void> {
	const controller = new AbortController()
	let inFlight: Promise<void> | null = null

	const tick = (): void => {
		if (controller.signal.aborted || inFlight) return
		inFlight = reconcileOnce(client, controller.signal)
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
