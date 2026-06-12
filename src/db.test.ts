import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createDb, displayName } from "./db.ts"

function fresh() {
	return createDb({ path: ":memory:" })
}

const baseMsg = {
	chat_id: "100",
	msg_id: 1,
	sender_id: "10",
	text: "hello",
	media_kind: null,
	sent_at: 1_700_000_000_000,
	received_at: 1_700_000_001_000,
}

describe("insertMessage", () => {
	test("returns true on first insert", () => {
		const db = fresh()
		assert.equal(db.insertMessage(baseMsg), true)
		db.close()
	})

	test("returns false on duplicate (chat_id, msg_id)", () => {
		const db = fresh()
		db.insertMessage(baseMsg)
		assert.equal(db.insertMessage(baseMsg), false)
		db.close()
	})
})

describe("markDeleted", () => {
	test("marks an existing row and returns matched:true", () => {
		const db = fresh()
		db.insertMessage(baseMsg)
		const [result] = db.markDeleted([1], 1_700_000_002_000)
		assert.equal(result?.matched, true)
		db.close()
	})

	test("returns matched:false for unknown msg_id", () => {
		const db = fresh()
		const [result] = db.markDeleted([999], 1_700_000_002_000)
		assert.equal(result?.matched, false)
		db.close()
	})

	test("does not re-mark an already-deleted row", () => {
		const db = fresh()
		db.insertMessage(baseMsg)
		db.markDeleted([1], 1_700_000_002_000)
		const [second] = db.markDeleted([1], 1_700_000_003_000)
		assert.equal(second?.matched, false)
		db.close()
	})

	test("batches multiple ids in one transaction", () => {
		const db = fresh()
		db.insertMessage({ ...baseMsg, msg_id: 1 })
		db.insertMessage({ ...baseMsg, msg_id: 2 })
		const results = db.markDeleted([1, 2, 999], 1_700_000_002_000)
		assert.deepEqual(
			results.map((r) => r.matched),
			[true, true, false],
		)
		db.close()
	})
})

describe("recordEdit", () => {
	test('returns "first-seen" when the message was never observed', () => {
		const db = fresh()
		const outcome = db.recordEdit({
			chat_id: "100",
			msg_id: 1,
			sender_id: "10",
			text: "first edit observed",
			media_kind: null,
			sent_at: 1_700_000_000_000,
			observed_at: 1_700_000_005_000,
		})
		assert.equal(outcome, "first-seen")
		// and the row was inserted
		assert.equal(db.listLiveMessageIds("100").length, 1)
		db.close()
	})

	test('returns "no-change" when text and media match cached', () => {
		const db = fresh()
		db.insertMessage(baseMsg)
		const outcome = db.recordEdit({
			chat_id: baseMsg.chat_id,
			msg_id: baseMsg.msg_id,
			sender_id: baseMsg.sender_id,
			text: baseMsg.text,
			media_kind: baseMsg.media_kind,
			sent_at: baseMsg.sent_at,
			observed_at: 1_700_000_005_000,
		})
		assert.equal(outcome, "no-change")
		db.close()
	})

	test('returns "revised" and snapshots prior text into revisions', () => {
		const db = fresh()
		db.insertMessage(baseMsg)
		const outcome = db.recordEdit({
			chat_id: baseMsg.chat_id,
			msg_id: baseMsg.msg_id,
			sender_id: baseMsg.sender_id,
			text: "edited version",
			media_kind: null,
			sent_at: baseMsg.sent_at,
			observed_at: 1_700_000_005_000,
		})
		assert.equal(outcome, "revised")
		db.close()
	})
})

describe("upsertUser + getMessageSender", () => {
	test("upsert then JOIN returns user identity", () => {
		const db = fresh()
		db.upsertUser({
			user_id: "10",
			username: "alice",
			first_name: "Alice",
			last_name: "Smith",
			updated_at: 1,
		})
		db.insertMessage(baseMsg)
		const sender = db.getMessageSender(1)
		assert.deepEqual(sender, {
			username: "alice",
			first_name: "Alice",
			last_name: "Smith",
		})
		db.close()
	})

	test("upsert overwrites fields on second call", () => {
		const db = fresh()
		db.upsertUser({
			user_id: "10",
			username: "alice",
			first_name: "Alice",
			last_name: null,
			updated_at: 1,
		})
		db.upsertUser({
			user_id: "10",
			username: "alice2",
			first_name: "Alice",
			last_name: "Smith",
			updated_at: 2,
		})
		db.insertMessage(baseMsg)
		const sender = db.getMessageSender(1)
		assert.equal(sender?.username, "alice2")
		assert.equal(sender?.last_name, "Smith")
		db.close()
	})
})

describe("listChatsWithLiveMessages", () => {
	test("excludes chats whose only message is deleted", () => {
		const db = fresh()
		db.insertMessage({ ...baseMsg, chat_id: "100", msg_id: 1 })
		db.insertMessage({ ...baseMsg, chat_id: "200", msg_id: 2 })
		db.markDeleted([1], Date.now())
		assert.deepEqual(db.listChatsWithLiveMessages(), ["200"])
		db.close()
	})
})

describe("displayName", () => {
	test('"First Last" when both present', () => {
		assert.equal(
			displayName({
				first_name: "John",
				last_name: "Doe",
				username: "jd",
			}),
			"John Doe",
		)
	})

	test("first name only", () => {
		assert.equal(
			displayName({
				first_name: "John",
				last_name: null,
				username: null,
			}),
			"John",
		)
	})

	test("falls back to @username", () => {
		assert.equal(
			displayName({
				first_name: null,
				last_name: null,
				username: "jd",
			}),
			"@jd",
		)
	})

	test('falls back to "(unknown)"', () => {
		assert.equal(
			displayName({
				first_name: null,
				last_name: null,
				username: null,
			}),
			"(unknown)",
		)
	})
})
