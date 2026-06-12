import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createCache, displayName } from "./cache.ts"

const baseMsg = {
	chat_id: "100",
	msg_id: 1,
	sender_id: "10",
	text: "hello",
	media_kind: null,
	view_once: false,
	sent_at: 1_700_000_000_000,
	received_at: 1_700_000_001_000,
}

describe("insertMessage", () => {
	test("returns true on first insert", () => {
		const c = createCache()
		assert.equal(c.insertMessage(baseMsg), true)
	})

	test("returns false on duplicate msg_id", () => {
		const c = createCache()
		c.insertMessage(baseMsg)
		assert.equal(c.insertMessage(baseMsg), false)
	})
})

describe("markDeleted", () => {
	test("marks existing row and untracks from live list", () => {
		const c = createCache()
		c.insertMessage(baseMsg)
		const [r] = c.markDeleted([1], 1_700_000_002_000)
		assert.equal(r?.matched, true)
		assert.deepEqual(c.listLiveMessageIds("100"), [])
	})

	test("returns matched:false for unknown msg_id", () => {
		const c = createCache()
		const [r] = c.markDeleted([999], 1_700_000_002_000)
		assert.equal(r?.matched, false)
	})

	test("does not re-mark an already-deleted row", () => {
		const c = createCache()
		c.insertMessage(baseMsg)
		c.markDeleted([1], 1_700_000_002_000)
		const [second] = c.markDeleted([1], 1_700_000_003_000)
		assert.equal(second?.matched, false)
	})

	test("batches multiple ids", () => {
		const c = createCache()
		c.insertMessage({ ...baseMsg, msg_id: 1 })
		c.insertMessage({ ...baseMsg, msg_id: 2 })
		const results = c.markDeleted([1, 2, 999], 1_700_000_002_000)
		assert.deepEqual(
			results.map((r) => r.matched),
			[true, true, false],
		)
	})
})

describe("recordEdit", () => {
	test('"first-seen" when message was never observed', () => {
		const c = createCache()
		const result = c.recordEdit({
			chat_id: "100",
			msg_id: 1,
			sender_id: "10",
			text: "first edit observed",
			media_kind: null,
			view_once: false,
			sent_at: 1_700_000_000_000,
			observed_at: 1_700_000_005_000,
		})
		assert.equal(result.kind, "first-seen")
		assert.equal(c.listLiveMessageIds("100").length, 1)
	})

	test('"no-change" when text and media match', () => {
		const c = createCache()
		c.insertMessage(baseMsg)
		const result = c.recordEdit({
			chat_id: baseMsg.chat_id,
			msg_id: baseMsg.msg_id,
			sender_id: baseMsg.sender_id,
			text: baseMsg.text,
			media_kind: baseMsg.media_kind,
			view_once: baseMsg.view_once,
			sent_at: baseMsg.sent_at,
			observed_at: 1_700_000_005_000,
		})
		assert.equal(result.kind, "no-change")
	})

	test('"revised" returns prior text in `before`', () => {
		const c = createCache()
		c.insertMessage(baseMsg)
		const result = c.recordEdit({
			chat_id: baseMsg.chat_id,
			msg_id: baseMsg.msg_id,
			sender_id: baseMsg.sender_id,
			text: "edited version",
			media_kind: null,
			view_once: false,
			sent_at: baseMsg.sent_at,
			observed_at: 1_700_000_005_000,
		})
		assert.equal(result.kind, "revised")
		if (result.kind === "revised") {
			assert.equal(result.before, "hello")
		}
	})
})

describe("upsertUser + getMessage", () => {
	test("getMessage joins sender from users", () => {
		const c = createCache()
		c.upsertUser({
			user_id: "10",
			username: "alice",
			first_name: "Alice",
			last_name: "Smith",
		})
		c.insertMessage(baseMsg)
		const snap = c.getMessage(1)
		assert.equal(snap?.sender?.first_name, "Alice")
		assert.equal(snap?.sender?.username, "alice")
	})

	test("upsert overwrites existing user", () => {
		const c = createCache()
		c.upsertUser({
			user_id: "10",
			username: "alice",
			first_name: "Alice",
			last_name: null,
		})
		c.upsertUser({
			user_id: "10",
			username: "alice2",
			first_name: "Alice",
			last_name: "Smith",
		})
		c.insertMessage(baseMsg)
		const snap = c.getMessage(1)
		assert.equal(snap?.sender?.username, "alice2")
		assert.equal(snap?.sender?.last_name, "Smith")
	})

	test("sender is null when user_id not in users map", () => {
		const c = createCache()
		c.insertMessage(baseMsg)
		assert.equal(c.getMessage(1)?.sender, null)
	})
})

describe("setMediaPath", () => {
	test("persists media path on the row", () => {
		const c = createCache()
		c.insertMessage(baseMsg)
		c.setMediaPath(baseMsg.chat_id, baseMsg.msg_id, "1.jpg")
		assert.equal(c.getMessage(1)?.media_path, "1.jpg")
	})

	test("ignores chat_id mismatch", () => {
		const c = createCache()
		c.insertMessage(baseMsg)
		c.setMediaPath("999", baseMsg.msg_id, "1.jpg")
		assert.equal(c.getMessage(1)?.media_path, null)
	})
})

describe("listChatsWithLiveMessages", () => {
	test("excludes chats whose only message is deleted", () => {
		const c = createCache()
		c.insertMessage({ ...baseMsg, chat_id: "100", msg_id: 1 })
		c.insertMessage({ ...baseMsg, chat_id: "200", msg_id: 2 })
		c.markDeleted([1], Date.now())
		assert.deepEqual(c.listChatsWithLiveMessages(), ["200"])
	})
})

describe("purgeOlderThan", () => {
	test("removes entries strictly below cutoff and returns count", () => {
		const c = createCache()
		c.insertMessage({ ...baseMsg, msg_id: 1, received_at: 100 })
		c.insertMessage({ ...baseMsg, msg_id: 2, received_at: 200 })
		c.insertMessage({ ...baseMsg, msg_id: 3, received_at: 300 })

		const result = c.purgeOlderThan(250)
		assert.equal(result.messages, 2)
		assert.equal(result.mediaPaths.length, 0)
		assert.deepEqual(c.listLiveMessageIds(baseMsg.chat_id), [3])
	})

	test("returns media paths of purged rows", () => {
		const c = createCache()
		c.insertMessage({ ...baseMsg, msg_id: 1, received_at: 100 })
		c.insertMessage({ ...baseMsg, msg_id: 2, received_at: 100 })
		c.setMediaPath(baseMsg.chat_id, 1, "1.jpg")
		c.setMediaPath(baseMsg.chat_id, 2, "2.ogg")

		const result = c.purgeOlderThan(200)
		assert.equal(result.messages, 2)
		assert.deepEqual(result.mediaPaths.sort(), ["1.jpg", "2.ogg"])
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
			displayName({ first_name: "John", last_name: null, username: null }),
			"John",
		)
	})

	test("falls back to @username", () => {
		assert.equal(
			displayName({ first_name: null, last_name: null, username: "jd" }),
			"@jd",
		)
	})

	test('falls back to "(unknown)"', () => {
		assert.equal(
			displayName({ first_name: null, last_name: null, username: null }),
			"(unknown)",
		)
	})
})
