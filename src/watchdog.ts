import type { TelegramClient } from "telegram"
import type { Logger } from "./logger.ts"

export interface WatchdogOptions {
	client: TelegramClient
	logger: Logger
	intervalMs: number
	probeTimeoutMs: number
	maxFailures: number
	onDead: () => void
}

/**
 * Proves the client can still do a round-trip to Telegram. GramJS can end up
 * in a zombie state — process alive, update loop dead — after it exhausts its
 * own reconnect attempts during a network outage; `connected` alone misses
 * cases where the socket is up but requests hang, hence the raced probe.
 */
async function probe(client: TelegramClient, timeoutMs: number): Promise<void> {
	if (client.connected !== true) {
		throw new Error("client reports disconnected")
	}
	let handle: NodeJS.Timeout | undefined
	const timeout = new Promise<never>((_, reject) => {
		handle = setTimeout(() => {
			reject(new Error(`probe timed out after ${timeoutMs}ms`))
		}, timeoutMs)
	})
	try {
		await Promise.race([client.getMe(), timeout])
	} finally {
		clearTimeout(handle)
	}
}

/**
 * Periodic liveness check. After `maxFailures` consecutive failed probes it
 * calls `onDead` (once) — in production that exits the process so systemd's
 * Restart=always replaces the zombie. Requiring consecutive failures keeps a
 * transient blip from triggering an exit, and spaces real exits far enough
 * apart that the unit's start-rate limit is never exhausted.
 */
export function startWatchdog(opts: WatchdogOptions): () => void {
	const { client, logger, intervalMs, probeTimeoutMs, maxFailures, onDead } =
		opts
	let failures = 0
	let inFlight = false

	const tick = async (): Promise<void> => {
		if (inFlight) return
		inFlight = true
		try {
			await probe(client, probeTimeoutMs)
			if (failures > 0) {
				logger.info({ failures }, "watchdog probe recovered")
			}
			failures = 0
		} catch (err) {
			failures++
			logger.warn({ err, failures, maxFailures }, "watchdog probe failed")
			if (failures >= maxFailures) {
				logger.fatal(
					{ failures },
					"telegram client unresponsive — exiting so systemd restarts us",
				)
				clearInterval(handle)
				onDead()
			}
		} finally {
			inFlight = false
		}
	}

	const handle = setInterval(() => {
		void tick()
	}, intervalMs)
	logger.info({ intervalMs, probeTimeoutMs, maxFailures }, "watchdog started")

	return (): void => {
		clearInterval(handle)
	}
}
