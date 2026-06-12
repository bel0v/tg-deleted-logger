import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import Database from "better-sqlite3"

const DB_PATH = process.env.TG_DB_PATH ?? "data/messages.db"
mkdirSync(dirname(DB_PATH), { recursive: true })

const db = new Database(DB_PATH)
db.pragma("journal_mode = WAL")
db.pragma("foreign_keys = ON")

db.exec(`
	CREATE TABLE IF NOT EXISTS messages (
		chat_id     TEXT    NOT NULL,
		msg_id      INTEGER NOT NULL,
		sender_id   TEXT,
		text        TEXT,
		media_kind  TEXT,
		received_at INTEGER NOT NULL,
		deleted_at  INTEGER,
		PRIMARY KEY (chat_id, msg_id)
	);
	CREATE INDEX IF NOT EXISTS idx_messages_msg_id     ON messages(msg_id);
	CREATE INDEX IF NOT EXISTS idx_messages_deleted_at ON messages(deleted_at);

	CREATE TABLE IF NOT EXISTS message_revisions (
		chat_id     TEXT    NOT NULL,
		msg_id      INTEGER NOT NULL,
		text        TEXT,
		observed_at INTEGER NOT NULL,
		PRIMARY KEY (chat_id, msg_id, observed_at)
	);
	CREATE INDEX IF NOT EXISTS idx_revisions_msg_id ON message_revisions(msg_id);
`)

export interface InsertParams {
	chat_id: string
	msg_id: number
	sender_id: string | null
	text: string | null
	media_kind: string | null
	received_at: number
}

const insertStmt = db.prepare<InsertParams>(`
	INSERT OR IGNORE INTO messages
		(chat_id, msg_id, sender_id, text, media_kind, received_at)
	VALUES
		(@chat_id, @msg_id, @sender_id, @text, @media_kind, @received_at)
`)

export function insertMessage(params: InsertParams): boolean {
	return insertStmt.run(params).changes > 0
}

// DeletedMessage events for private chats don't carry chat_id — message IDs
// are unique across the account, so we look up by msg_id alone.
const markDeletedStmt = db.prepare<{ msg_id: number; deleted_at: number }>(`
	UPDATE messages
	SET deleted_at = @deleted_at
	WHERE msg_id = @msg_id AND deleted_at IS NULL
`)

export interface MarkDeletedResult {
	msg_id: number
	matched: boolean
}

export function markDeleted(
	msgIds: number[],
	deletedAt: number,
): MarkDeletedResult[] {
	return msgIds.map((msg_id) => {
		const changes = markDeletedStmt.run({
			msg_id,
			deleted_at: deletedAt,
		}).changes
		return { msg_id, matched: changes > 0 }
	})
}

const getMessageStmt = db.prepare<{ chat_id: string; msg_id: number }>(`
	SELECT text, media_kind FROM messages
	WHERE chat_id = @chat_id AND msg_id = @msg_id
`)

const insertRevisionStmt = db.prepare<{
	chat_id: string
	msg_id: number
	text: string | null
	observed_at: number
}>(`
	INSERT INTO message_revisions (chat_id, msg_id, text, observed_at)
	VALUES (@chat_id, @msg_id, @text, @observed_at)
`)

const updateMessageStmt = db.prepare<{
	chat_id: string
	msg_id: number
	text: string | null
	media_kind: string | null
}>(`
	UPDATE messages
	SET text = @text, media_kind = @media_kind
	WHERE chat_id = @chat_id AND msg_id = @msg_id
`)

export interface EditParams {
	chat_id: string
	msg_id: number
	sender_id: string | null
	text: string | null
	media_kind: string | null
	observed_at: number
}

export type EditOutcome = "first-seen" | "no-change" | "revised"

interface CurrentRow {
	text: string | null
	media_kind: string | null
}

const listChatsStmt = db.prepare(`
	SELECT DISTINCT chat_id FROM messages WHERE deleted_at IS NULL
`)

export function listChatsWithLiveMessages(): string[] {
	const rows = listChatsStmt.all() as { chat_id: string }[]
	return rows.map((r) => r.chat_id)
}

const listLiveIdsStmt = db.prepare<{ chat_id: string }>(`
	SELECT msg_id FROM messages WHERE chat_id = @chat_id AND deleted_at IS NULL
`)

export function listLiveMessageIds(chatId: string): number[] {
	const rows = listLiveIdsStmt.all({ chat_id: chatId }) as { msg_id: number }[]
	return rows.map((r) => r.msg_id)
}

export const recordEdit = db.transaction((params: EditParams): EditOutcome => {
	const current = getMessageStmt.get({
		chat_id: params.chat_id,
		msg_id: params.msg_id,
	}) as CurrentRow | undefined

	if (!current) {
		insertMessage({
			chat_id: params.chat_id,
			msg_id: params.msg_id,
			sender_id: params.sender_id,
			text: params.text,
			media_kind: params.media_kind,
			received_at: params.observed_at,
		})
		return "first-seen"
	}

	if (
		current.text === params.text &&
		current.media_kind === params.media_kind
	) {
		return "no-change"
	}

	insertRevisionStmt.run({
		chat_id: params.chat_id,
		msg_id: params.msg_id,
		text: current.text,
		observed_at: params.observed_at,
	})
	updateMessageStmt.run({
		chat_id: params.chat_id,
		msg_id: params.msg_id,
		text: params.text,
		media_kind: params.media_kind,
	})
	return "revised"
})
