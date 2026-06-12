import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { pino } from "pino"
import type { TelegramClient } from "telegram"
import { createCache, type InsertParams } from "./cache.ts"
import type { DeleteNotification, Notifier } from "./notifier.ts"
import { isMessageEmpty, startReconcileLoop } from "./reconciler.ts"

describe("isMessageEmpty", () => {
	test("undefined → true", () => {
		assert.equal(isMessageEmpty(undefined), true)
	})

	test("null → true", () => {
		assert.equal(isMessageEmpty(null), true)
	})

	test('className "MessageEmpty" → true', () => {
		assert.equal(isMessageEmpty({ className: "MessageEmpty" }), true)
	})

	test('className "Message" → false', () => {
		assert.equal(isMessageEmpty({ className: "Message" }), false)
	})

	test("object without className → false", () => {
		assert.equal(isMessageEmpty({}), false)
	})

	test("primitive non-null → false", () => {
		assert.equal(isMessageEmpty(42), false)
		assert.equal(isMessageEmpty("MessageEmpty"), false)
	})
})

const baseInsert = (msgId: number): InsertParams => ({
	chat_id: "5",
	msg_id: msgId,
	sender_id: "5",
	text: `m${msgId}`,
	media_kind: null,
	view_once: false,
	sent_at: 1,
	received_at: 1,
})

interface FakeClientOpts {
	byBatch: Record<string, Array<{ className: string } | null>>
}

function createFakeClient(opts: FakeClientOpts): TelegramClient {
	return {
		getMessages: async (_peer: unknown, params: { ids: number[] }) =>
			opts.byBatch[params.ids.join(",")] ?? [],
	} as unknown as TelegramClient
}

function createRecordingNotifier(): {
	notifier: Notifier
	deletes: DeleteNotification[]
} {
	const deletes: DeleteNotification[] = []
	const notifier: Notifier = {
		notifyDelete: async (n) => {
			deletes.push(n)
		},
		notifyEdit: async () => {},
	}
	return { notifier, deletes }
}

function silentLogger() {
	const log = pino()
	log.level = "silent"
	return log
}

describe("reconciler diff", () => {
	test("detects silent deletions and notifies once each", async () => {
		const cache = createCache()
		for (const id of [100, 101, 102]) cache.insertMessage(baseInsert(id))

		const client = createFakeClient({
			byBatch: {
				"100,101,102": [
					{ className: "Message" },
					{ className: "MessageEmpty" },
					{ className: "Message" },
				],
			},
		})
		const { notifier, deletes } = createRecordingNotifier()

		const stop = startReconcileLoop({
			client,
			cache,
			logger: silentLogger(),
			notifier,
			intervalMs: 1_000_000,
		})
		await stop()

		assert.equal(deletes.length, 1)
		assert.equal(deletes[0]?.msgId, 101)
		assert.equal(deletes[0]?.via, "reconcile")
		assert.deepEqual(cache.listLiveMessageIds("5"), [100, 102])
	})

	test("no notifications when all messages still exist", async () => {
		const cache = createCache()
		cache.insertMessage(baseInsert(200))

		const client = createFakeClient({
			byBatch: { "200": [{ className: "Message" }] },
		})
		const { notifier, deletes } = createRecordingNotifier()

		const stop = startReconcileLoop({
			client,
			cache,
			logger: silentLogger(),
			notifier,
			intervalMs: 1_000_000,
		})
		await stop()

		assert.equal(deletes.length, 0)
		assert.deepEqual(cache.listLiveMessageIds("5"), [200])
	})

	test("does not re-notify a message already marked deleted", async () => {
		const cache = createCache()
		cache.insertMessage(baseInsert(300))
		cache.markDeleted([300], Date.now())

		const client = createFakeClient({ byBatch: {} })
		const { notifier, deletes } = createRecordingNotifier()

		const stop = startReconcileLoop({
			client,
			cache,
			logger: silentLogger(),
			notifier,
			intervalMs: 1_000_000,
		})
		await stop()

		assert.equal(deletes.length, 0)
	})
})
