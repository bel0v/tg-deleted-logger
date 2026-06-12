import type { Logger } from "pino"
import { pino } from "pino"

export type { Logger }

export function createLogger(): Logger {
	const isTTY = process.stdout.isTTY === true

	return pino({
		level: process.env.LOG_LEVEL ?? "info",
		...(isTTY
			? {
					transport: {
						target: "pino-pretty",
						options: { colorize: true, translateTime: "HH:MM:ss" },
					},
				}
			: {}),
	})
}
