import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import Database from "better-sqlite3"

export interface InsertParams {
	chat_id: string
	msg_id: number
	sender_id: string | null
	text: string | null
	media_kind: string | null
	sent_at: number | null
	received_at: number
}

export interface MarkDeletedResult {
	msg_id: number
	matched: boolean
}

export interface EditParams {
	chat_id: string
	msg_id: number
	sender_id: string | null
	text: string | null
	media_kind: string | null
	sent_at: number | null
	observed_at: number
}

export type EditOutcome = "first-seen" | "no-change" | "revised"

export interface UpsertUserParams {
	user_id: string
	username: string | null
	first_name: string | null
	last_name: string | null
	updated_at: number
}

export interface UserIdentity {
	username: string | null
	first_name: string | null
	last_name: string | null
}

export interface DbApi {
	insertMessage(params: InsertParams): boolean
	markDeleted(msgIds: number[], deletedAt: number): MarkDeletedResult[]
	recordEdit(params: EditParams): EditOutcome
	upsertUser(params: UpsertUserParams): void
	getMessageSender(msgId: number): UserIdentity | undefined
	listChatsWithLiveMessages(): string[]
	listLiveMessageIds(chatId: string): number[]
	close(): void
}

export interface DbOptions {
	path?: string
}

interface CurrentRow {
	text: string | null
	media_kind: string | null
}

export function createDb(options: DbOptions = {}): DbApi {
	const dbPath = options.path ?? process.env.TG_DB_PATH ?? "data/messages.db"
	mkdirSync(dirname(dbPath), { recursive: true })

	const db = new Database(dbPath)
	db.pragma("journal_mode = WAL")
	db.pragma("foreign_keys = ON")

	db.exec(`
		CREATE TABLE IF NOT EXISTS messages (
			chat_id     TEXT    NOT NULL,
			msg_id      INTEGER NOT NULL,
			sender_id   TEXT,
			text        TEXT,
			media_kind  TEXT,
			sent_at     INTEGER,
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

		CREATE TABLE IF NOT EXISTS users (
			user_id    TEXT    PRIMARY KEY,
			username   TEXT,
			first_name TEXT,
			last_name  TEXT,
			updated_at INTEGER NOT NULL
		);
	`)

	const insertStmt = db.prepare<InsertParams>(`
		INSERT OR IGNORE INTO messages
			(chat_id, msg_id, sender_id, text, media_kind, sent_at, received_at)
		VALUES
			(@chat_id, @msg_id, @sender_id, @text, @media_kind, @sent_at, @received_at)
	`)

	// DeletedMessage events for private chats don't carry chat_id — message IDs
	// are unique across the account, so we look up by msg_id alone.
	const markDeletedStmt = db.prepare<{ msg_id: number; deleted_at: number }>(`
		UPDATE messages
		SET deleted_at = @deleted_at
		WHERE msg_id = @msg_id AND deleted_at IS NULL
	`)

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

	const upsertUserStmt = db.prepare<UpsertUserParams>(`
		INSERT INTO users (user_id, username, first_name, last_name, updated_at)
		VALUES (@user_id, @username, @first_name, @last_name, @updated_at)
		ON CONFLICT(user_id) DO UPDATE SET
			username   = excluded.username,
			first_name = excluded.first_name,
			last_name  = excluded.last_name,
			updated_at = excluded.updated_at
	`)

	const getMessageSenderStmt = db.prepare<{ msg_id: number }>(`
		SELECT u.username, u.first_name, u.last_name
		FROM messages m
		LEFT JOIN users u ON u.user_id = m.sender_id
		WHERE m.msg_id = @msg_id
		LIMIT 1
	`)

	const listChatsStmt = db.prepare(`
		SELECT DISTINCT chat_id FROM messages WHERE deleted_at IS NULL
	`)

	const listLiveIdsStmt = db.prepare<{ chat_id: string }>(`
		SELECT msg_id FROM messages WHERE chat_id = @chat_id AND deleted_at IS NULL
	`)

	function insertMessage(params: InsertParams): boolean {
		return insertStmt.run(params).changes > 0
	}

	const markDeleted = db.transaction(
		(msgIds: number[], deletedAt: number): MarkDeletedResult[] =>
			msgIds.map((msg_id) => {
				const changes = markDeletedStmt.run({
					msg_id,
					deleted_at: deletedAt,
				}).changes
				return { msg_id, matched: changes > 0 }
			}),
	)

	const recordEdit = db.transaction((params: EditParams): EditOutcome => {
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
				sent_at: params.sent_at,
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

	return {
		insertMessage,
		markDeleted,
		recordEdit,
		upsertUser: (params) => {
			upsertUserStmt.run(params)
		},
		getMessageSender: (msgId) =>
			getMessageSenderStmt.get({ msg_id: msgId }) as UserIdentity | undefined,
		listChatsWithLiveMessages: () =>
			(listChatsStmt.all() as { chat_id: string }[]).map((r) => r.chat_id),
		listLiveMessageIds: (chatId) =>
			(listLiveIdsStmt.all({ chat_id: chatId }) as { msg_id: number }[]).map(
				(r) => r.msg_id,
			),
		close: () => {
			db.close()
		},
	}
}

export function displayName(u: UserIdentity): string {
	const full = [u.first_name, u.last_name].filter(Boolean).join(" ").trim()
	if (full) return full
	if (u.username) return `@${u.username}`
	return "(unknown)"
}
