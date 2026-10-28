/** Raw URL of the community blocklist (the `blob` URL on GitHub serves an HTML page). */
export const DEFAULT_SOURCE_URL =
  'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf';

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/** The real list is well under 200 KB; this only guards against runaway responses. */
export const DEFAULT_MAX_DATASET_BYTES = 2 * 1024 * 1024;

/** A dataset with fewer domains than this is treated as broken (truncated or an error page). */
export const DEFAULT_MIN_DOMAINS = 500;

/** Share of non-comment lines allowed to be invalid before the whole dataset is rejected. */
export const DEFAULT_MAX_INVALID_RATIO = 0.01;

/** A new list smaller than this share of the current one is rejected as suspicious. */
export const DEFAULT_MIN_SHRINK_RATIO = 0.5;

export const DEFAULT_REDIS_KEY_PREFIX = 'mailsniff:v1';

export const DEFAULT_REDIS_CONNECT_TIMEOUT_MS = 5_000;

/** Minimum lifetime of the cross-instance refresh lock. */
export const DEFAULT_REFRESH_LOCK_TTL_MS = 60_000;

/** Added to the download timeout so the lock outlives the slowest permitted download. */
export const REFRESH_LOCK_TIMEOUT_MARGIN_MS = 20_000;

/**
 * Scheduled refreshes skip the download when a shared snapshot is younger than this share
 * of the refresh interval, so instances sharing Redis do not all download in turn.
 */
export const REFRESH_FRESHNESS_RATIO = 0.5;

export const REFRESH_INITIAL_BACKOFF_MS = 60_000;

/** Scheduled delays vary by ±10% so instances do not wake up in lockstep. */
export const REFRESH_JITTER_RATIO = 0.1;

/** Minimum time between background checks for changes made by other instances. */
export const VERSION_CHECK_INTERVAL_MS = 30_000;

export const PEER_POLL_INTERVAL_MS = 250;

/** Added to the download timeout when waiting for a peer's download to land in the cache. */
export const PEER_WAIT_MARGIN_MS = 2_000;
