import { pino } from "pino"

const isTTY = process.stdout.isTTY === true

export const logger = pino({
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
