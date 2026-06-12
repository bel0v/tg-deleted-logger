import { Time } from "./time.ts"

export const DEFAULT_RECONCILE_INTERVAL_MS = 10 * Time.MINUTE
export const MIN_RECONCILE_INTERVAL_MS = Time.SECOND
export const SHUTDOWN_TIMEOUT_MS = 10 * Time.SECOND
export const DEFAULT_RETENTION_DAYS = 1
export const MIN_RETENTION_DAYS = 1
export const PURGE_INTERVAL_MS = Time.DAY
