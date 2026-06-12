export interface InsertParams {
	chat_id: string
	msg_id: number
	sender_id: string | null
	text: string | null
	media_kind: string | null
	view_once: boolean
	sent_at: number | null
	received_at: number
}

export interface EditParams {
	chat_id: string
	msg_id: number
	sender_id: string | null
	text: string | null
	media_kind: string | null
	view_once: boolean
	sent_at: number | null
	observed_at: number
}

export interface UpsertUserParams {
	user_id: string
	username: string | null
	first_name: string | null
	last_name: string | null
}

export interface UserIdentity {
	username: string | null
	first_name: string | null
	last_name: string | null
}

export interface MarkDeletedResult {
	msg_id: number
	matched: boolean
}

export type EditOutcome =
	| { kind: "first-seen" }
	| { kind: "no-change" }
	| { kind: "revised"; before: string | null }

export interface MessageSnapshot {
	chat_id: string
	text: string | null
	media_kind: string | null
	media_path: string | null
	view_once: boolean
	sender: UserIdentity | null
}

export interface PurgeResult {
	messages: number
	mediaPaths: string[]
}

export interface CacheApi {
	insertMessage(params: InsertParams): boolean
	markDeleted(msgIds: number[], deletedAt: number): MarkDeletedResult[]
	recordEdit(params: EditParams): EditOutcome
	upsertUser(params: UpsertUserParams): void
	getMessage(msgId: number): MessageSnapshot | undefined
	setMediaPath(chatId: string, msgId: number, path: string): void
	listChatsWithLiveMessages(): string[]
	listLiveMessageIds(chatId: string): number[]
	purgeOlderThan(cutoffMs: number): PurgeResult
}

interface CachedMessage {
	chat_id: string
	msg_id: number
	sender_id: string | null
	text: string | null
	media_kind: string | null
	media_path: string | null
	view_once: boolean
	sent_at: number | null
	received_at: number
	deleted_at: number | null
}

export function createCache(): CacheApi {
	// msg_id is unique across the account (Telegram guarantee), so we key by it.
	const messages = new Map<number, CachedMessage>()
	// chat_id → live msg_ids (deleted ones removed eagerly), for the reconciler.
	const liveByChatId = new Map<string, Set<number>>()
	const users = new Map<string, UserIdentity>()

	function trackLive(chatId: string, msgId: number): void {
		let set = liveByChatId.get(chatId)
		if (!set) {
			set = new Set()
			liveByChatId.set(chatId, set)
		}
		set.add(msgId)
	}

	function untrackLive(chatId: string, msgId: number): void {
		const set = liveByChatId.get(chatId)
		if (!set) return
		set.delete(msgId)
		if (set.size === 0) liveByChatId.delete(chatId)
	}

	function insertMessage(p: InsertParams): boolean {
		if (messages.has(p.msg_id)) return false
		messages.set(p.msg_id, {
			chat_id: p.chat_id,
			msg_id: p.msg_id,
			sender_id: p.sender_id,
			text: p.text,
			media_kind: p.media_kind,
			media_path: null,
			view_once: p.view_once,
			sent_at: p.sent_at,
			received_at: p.received_at,
			deleted_at: null,
		})
		trackLive(p.chat_id, p.msg_id)
		return true
	}

	function markDeleted(
		msgIds: number[],
		deletedAt: number,
	): MarkDeletedResult[] {
		return msgIds.map((msg_id) => {
			const m = messages.get(msg_id)
			if (!m || m.deleted_at !== null) {
				return { msg_id, matched: false }
			}
			m.deleted_at = deletedAt
			untrackLive(m.chat_id, m.msg_id)
			return { msg_id, matched: true }
		})
	}

	function recordEdit(p: EditParams): EditOutcome {
		const current = messages.get(p.msg_id)
		if (!current) {
			insertMessage({
				chat_id: p.chat_id,
				msg_id: p.msg_id,
				sender_id: p.sender_id,
				text: p.text,
				media_kind: p.media_kind,
				view_once: p.view_once,
				sent_at: p.sent_at,
				received_at: p.observed_at,
			})
			return { kind: "first-seen" }
		}
		if (current.text === p.text && current.media_kind === p.media_kind) {
			return { kind: "no-change" }
		}
		const before = current.text
		current.text = p.text
		current.media_kind = p.media_kind
		return { kind: "revised", before }
	}

	function upsertUser(p: UpsertUserParams): void {
		users.set(p.user_id, {
			username: p.username,
			first_name: p.first_name,
			last_name: p.last_name,
		})
	}

	function getMessage(msgId: number): MessageSnapshot | undefined {
		const m = messages.get(msgId)
		if (!m) return undefined
		const sender =
			m.sender_id !== null ? (users.get(m.sender_id) ?? null) : null
		return {
			chat_id: m.chat_id,
			text: m.text,
			media_kind: m.media_kind,
			media_path: m.media_path,
			view_once: m.view_once,
			sender,
		}
	}

	function setMediaPath(chatId: string, msgId: number, path: string): void {
		const m = messages.get(msgId)
		if (m && m.chat_id === chatId) {
			m.media_path = path
		}
	}

	function listChatsWithLiveMessages(): string[] {
		return Array.from(liveByChatId.keys())
	}

	function listLiveMessageIds(chatId: string): number[] {
		const set = liveByChatId.get(chatId)
		return set ? Array.from(set) : []
	}

	function purgeOlderThan(cutoffMs: number): PurgeResult {
		let count = 0
		const mediaPaths: string[] = []
		for (const [msgId, m] of messages) {
			if (m.received_at < cutoffMs) {
				if (m.media_path) mediaPaths.push(m.media_path)
				untrackLive(m.chat_id, msgId)
				messages.delete(msgId)
				count++
			}
		}
		return { messages: count, mediaPaths }
	}

	return {
		insertMessage,
		markDeleted,
		recordEdit,
		upsertUser,
		getMessage,
		setMediaPath,
		listChatsWithLiveMessages,
		listLiveMessageIds,
		purgeOlderThan,
	}
}

export function displayName(u: UserIdentity): string {
	const full = [u.first_name, u.last_name].filter(Boolean).join(" ").trim()
	if (full) return full
	if (u.username) return `@${u.username}`
	return "(unknown)"
}
