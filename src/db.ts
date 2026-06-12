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
