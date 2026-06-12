import { join } from "node:path"
import type { TelegramClient } from "telegram"

import type { MessageSnapshot } from "./cache.ts"
import type { Logger } from "./logger.ts"

// Telegram outbound limits. Going over silently fails the send.
const MAX_MESSAGE_LEN = 4096
const MAX_CAPTION_LEN = 1024

function truncate(text: string, max: number): string {
	if (text.length <= max) return text
	return `${text.slice(0, max - 1)}…`
}

export interface DeleteNotification {
	msgId: number
	sender: string
	snapshot: MessageSnapshot
	via: "event" | "reconcile"
}

export interface EditNotification {
	msgId: number
	sender: string
	before: string | null
	after: string | null
}

export interface Notifier {
	notifyDelete(n: DeleteNotification): Promise<void>
	notifyEdit(n: EditNotification): Promise<void>
}

export interface NotifierDeps {
	client: TelegramClient
	logger: Logger
	target: string
	mediaDir: string
}

export function formatDelete(n: DeleteNotification): string {
	const tag = n.via === "reconcile" ? " (silent)" : ""
	const viewOnce = n.snapshot.view_once ? "🔥 view-once " : ""
	const lines: string[] = [`🗑️ ${viewOnce}Deleted by ${n.sender}${tag}`]
	if (n.snapshot.text) {
		lines.push("", n.snapshot.text)
	}
	return lines.join("\n")
}

export function formatEdit(n: EditNotification): string {
	return [
		`✏️ Edited by ${n.sender}`,
		"",
		"— before —",
		n.before ?? "(empty)",
		"",
		"— after —",
		n.after ?? "(empty)",
	].join("\n")
}

// Telegram entity-resolution accepts strings ("me", "@username") or numbers
// (peer IDs). For numeric env values we convert so GramJS doesn't mis-parse
// them as usernames; everything else passes through.
function resolveTarget(raw: string): string | number {
	if (raw === "me" || raw.startsWith("@")) return raw
	const asNum = Number(raw)
	if (Number.isSafeInteger(asNum)) return asNum
	return raw
}

export function createNotifier(deps: NotifierDeps): Notifier {
	const { client, logger, target, mediaDir } = deps
	const peer = resolveTarget(target)

	return {
		async notifyDelete(n: DeleteNotification): Promise<void> {
			try {
				const body = formatDelete(n)
				if (n.snapshot.media_path) {
					await client.sendFile(peer, {
						file: join(mediaDir, n.snapshot.media_path),
						caption: truncate(body, MAX_CAPTION_LEN),
					})
				} else {
					await client.sendMessage(peer, {
						message: truncate(body, MAX_MESSAGE_LEN),
					})
				}
			} catch (err) {
				logger.warn({ msgId: n.msgId, err }, "notify delete failed")
			}
		},
		async notifyEdit(n: EditNotification): Promise<void> {
			try {
				await client.sendMessage(peer, {
					message: truncate(formatEdit(n), MAX_MESSAGE_LEN),
				})
			} catch (err) {
				logger.warn({ msgId: n.msgId, err }, "notify edit failed")
			}
		},
	}
}
