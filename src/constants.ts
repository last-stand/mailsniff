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

export const DEFAULT_REDIS_KEY_PREFIX = 'mailsniff:v1';

export const DEFAULT_REDIS_CONNECT_TIMEOUT_MS = 5_000;
