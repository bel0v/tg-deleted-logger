import type { CacheApi } from "./cache.ts"
import {
	DEFAULT_RETENTION_DAYS,
	MIN_RETENTION_DAYS,
	PURGE_INTERVAL_MS,
} from "./constants.ts"
import type { Logger } from "./logger.ts"
import { Time } from "./time.ts"

function parseRetentionDays(raw: string | undefined, logger: Logger): number {
	if (raw === undefined) {
		return DEFAULT_RETENTION_DAYS
	}
	const parsed = Number(raw)
	if (!Number.isFinite(parsed) || parsed < MIN_RETENTION_DAYS) {
		logger.warn(
			{ raw, fallback: DEFAULT_RETENTION_DAYS },
			"TG_RETENTION_DAYS invalid, using default",
		)
		return DEFAULT_RETENTION_DAYS
	}
	return parsed
}

interface RetentionDeps {
	logger: Logger
	cache: CacheApi
}

export function startRetentionLoop({
	logger,
	cache,
}: RetentionDeps): () => void {
	const retentionDays = parseRetentionDays(
		process.env.TG_RETENTION_DAYS,
		logger,
	)
	const runPurge = (): void => {
		const cutoff = Date.now() - retentionDays * Time.DAY
		const result = cache.purgeOlderThan(cutoff)
		if (result.messages > 0) {
			logger.info(
				{
					messages: result.messages,
					mediaPaths: result.mediaPaths.length,
					retentionDays,
					cutoff,
				},
				"retention purge",
			)
		}
	}
	runPurge()
	const purgeHandle = setInterval(runPurge, PURGE_INTERVAL_MS)
	logger.info({ retentionDays }, "retention loop started")
	return (): void => {
		clearInterval(purgeHandle)
	}
}
