import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { MessageSnapshot } from "./cache.ts"
import { formatDelete, formatEdit } from "./notifier.ts"

function snapshot(overrides: Partial<MessageSnapshot> = {}): MessageSnapshot {
	return {
		chat_id: "100",
		text: "hello",
		media_kind: null,
		media_path: null,
		view_once: false,
		sender: null,
		...overrides,
	}
}

describe("formatDelete", () => {
	test("text-only delete via event", () => {
		const out = formatDelete({
			msgId: 1,
			sender: "Alice",
			snapshot: snapshot({ text: "hi" }),
			via: "event",
		})
		assert.equal(out, "🗑️ Deleted by Alice\n\nhi")
	})

	test("reconciler-detected delete is tagged (silent)", () => {
		const out = formatDelete({
			msgId: 1,
			sender: "Alice",
			snapshot: snapshot({ text: "hi" }),
			via: "reconcile",
		})
		assert.match(out, /^🗑️ Deleted by Alice \(silent\)/)
	})

	test("view-once delete is tagged 🔥 view-once", () => {
		const out = formatDelete({
			msgId: 1,
			sender: "Alice",
			snapshot: snapshot({ view_once: true, text: "hi" }),
			via: "event",
		})
		assert.match(out, /^🗑️ 🔥 view-once Deleted by Alice/)
	})

	test("view-once + silent combine", () => {
		const out = formatDelete({
			msgId: 1,
			sender: "Alice",
			snapshot: snapshot({ view_once: true, text: "hi" }),
			via: "reconcile",
		})
		assert.match(out, /^🗑️ 🔥 view-once Deleted by Alice \(silent\)/)
	})

	test("media-only delete (no text) is just the header", () => {
		const out = formatDelete({
			msgId: 1,
			sender: "Alice",
			snapshot: snapshot({ text: null, media_path: "1.jpg" }),
			via: "event",
		})
		assert.equal(out, "🗑️ Deleted by Alice")
	})
})

describe("formatEdit", () => {
	test("both sides populated", () => {
		const out = formatEdit({
			msgId: 1,
			sender: "Alice",
			before: "I hate Mondays",
			after: "I love Mondays",
		})
		assert.equal(
			out,
			[
				"✏️ Edited by Alice",
				"",
				"— before —",
				"I hate Mondays",
				"",
				"— after —",
				"I love Mondays",
			].join("\n"),
		)
	})

	test("null before becomes (empty)", () => {
		const out = formatEdit({
			msgId: 1,
			sender: "Alice",
			before: null,
			after: "added text",
		})
		assert.match(out, /— before —\n\(empty\)/)
	})

	test("null after becomes (empty)", () => {
		const out = formatEdit({
			msgId: 1,
			sender: "Alice",
			before: "previous",
			after: null,
		})
		assert.match(out, /— after —\n\(empty\)/)
	})
})
