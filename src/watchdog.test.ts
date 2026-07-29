import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { pino } from "pino"
import type { TelegramClient } from "telegram"
import { startWatchdog } from "./watchdog.ts"

function silentLogger() {
	const log = pino()
	log.level = "silent"
	return log
}

interface FakeClientOpts {
	connected?: boolean
	getMe?: () => Promise<unknown>
}

function createFakeClient(opts: FakeClientOpts): TelegramClient {
	return {
		connected: opts.connected ?? true,
		getMe: opts.getMe ?? (async () => ({})),
	} as unknown as TelegramClient
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now()
	while (!cond()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitFor timed out")
		}
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms))
}

describe("watchdog", () => {
	test("healthy client never triggers onDead", async () => {
		let deaths = 0
		const stop = startWatchdog({
			client: createFakeClient({}),
			logger: silentLogger(),
			intervalMs: 5,
			probeTimeoutMs: 50,
			maxFailures: 2,
			onDead: () => {
				deaths++
			},
		})
		await sleep(100)
		stop()

		assert.equal(deaths, 0)
	})

	test("onDead fires exactly once after maxFailures consecutive failures", async () => {
		let deaths = 0
		const stop = startWatchdog({
			client: createFakeClient({
				getMe: async () => {
					throw new Error("Cannot send requests while disconnected")
				},
			}),
			logger: silentLogger(),
			intervalMs: 5,
			probeTimeoutMs: 50,
			maxFailures: 3,
			onDead: () => {
				deaths++
			},
		})
		await waitFor(() => deaths >= 1)
		await sleep(50)
		stop()

		assert.equal(deaths, 1)
	})

	test("disconnected client counts as failure without probing", async () => {
		let deaths = 0
		let probes = 0
		const stop = startWatchdog({
			client: createFakeClient({
				connected: false,
				getMe: async () => {
					probes++
					return {}
				},
			}),
			logger: silentLogger(),
			intervalMs: 5,
			probeTimeoutMs: 50,
			maxFailures: 2,
			onDead: () => {
				deaths++
			},
		})
		await waitFor(() => deaths >= 1)
		stop()

		assert.equal(probes, 0)
	})

	test("a successful probe resets the failure counter", async () => {
		let deaths = 0
		let calls = 0
		const stop = startWatchdog({
			// fail, fail, succeed, repeat — never 3 consecutive failures
			client: createFakeClient({
				getMe: async () => {
					calls++
					if (calls % 3 !== 0) throw new Error("TIMEOUT")
					return {}
				},
			}),
			logger: silentLogger(),
			intervalMs: 5,
			probeTimeoutMs: 50,
			maxFailures: 3,
			onDead: () => {
				deaths++
			},
		})
		await waitFor(() => calls >= 9)
		stop()

		assert.equal(deaths, 0)
	})

	test("a hung probe counts as failure via timeout", async () => {
		let deaths = 0
		const stop = startWatchdog({
			client: createFakeClient({
				getMe: () => new Promise(() => {}),
			}),
			logger: silentLogger(),
			intervalMs: 5,
			probeTimeoutMs: 10,
			maxFailures: 2,
			onDead: () => {
				deaths++
			},
		})
		await waitFor(() => deaths >= 1)
		stop()

		assert.equal(deaths, 1)
	})
})
