import { Time } from "./time.ts"

export const DEFAULT_RECONCILE_INTERVAL_MS = 10 * Time.MINUTE
export const MIN_RECONCILE_INTERVAL_MS = Time.SECOND
export const SHUTDOWN_TIMEOUT_MS = 10 * Time.SECOND
export const WATCHDOG_INTERVAL_MS = Time.MINUTE
export const WATCHDOG_PROBE_TIMEOUT_MS = 30 * Time.SECOND
// 3 consecutive failures ≈ 3 min before exiting — long enough that restart
// cycles can never exhaust the unit's StartLimitBurst=5 / 120s window.
export const WATCHDOG_MAX_FAILURES = 3
export const DEFAULT_RETENTION_DAYS = 1
export const MIN_RETENTION_DAYS = 1
export const PURGE_INTERVAL_MS = Time.DAY
