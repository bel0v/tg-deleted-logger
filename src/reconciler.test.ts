import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { isMessageEmpty } from "./reconciler.ts"

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
