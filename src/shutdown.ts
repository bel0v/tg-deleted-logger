import type { TelegramClient } from "telegram"
import { SHUTDOWN_TIMEOUT_MS } from "./constants.ts"
import type { Logger } from "./logger.ts"

interface ShutdownDeps {
	logger: Logger
	stopReconcile: () => Promise<void>
	stopRetention: () => void
	stopWatchdog: () => void
	client: TelegramClient
}

export function registerShutdown(deps: ShutdownDeps): void {
	const { logger, stopReconcile, stopRetention, stopWatchdog, client } = deps
	let shuttingDown = false

	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) {
			logger.warn({ signal }, "shutdown already in progress, ignoring signal")
			return
		}
		shuttingDown = true
		logger.info({ signal }, "shutdown")

		const cleanup = async (): Promise<"ok"> => {
			stopWatchdog()
			stopRetention()
			await stopReconcile()
			await client.disconnect()
			return "ok"
		}

		const timeout = new Promise<"timeout">((resolve) => {
			setTimeout(() => {
				resolve("timeout")
			}, SHUTDOWN_TIMEOUT_MS)
		})

		const winner = await Promise.race([cleanup(), timeout])
		if (winner === "timeout") {
			logger.error(
				{ timeoutMs: SHUTDOWN_TIMEOUT_MS },
				"shutdown timed out, forcing exit",
			)
			process.exit(1)
		}
		process.exit(0)
	}

	process.on("SIGINT", () => {
		void shutdown("SIGINT")
	})
	process.on("SIGTERM", () => {
		void shutdown("SIGTERM")
	})
}
