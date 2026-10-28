import type { DomainCache } from './cache/domain-cache';
import type { RedisClientLike } from './cache/redis-client';
import type { FetchLike } from './dataset/fetcher';

/**
 * A duration: milliseconds as a number, or a string such as `"30m"`, `"12h"`, `"1d"`.
 * Supported units: `m` (minutes), `h` (hours), `d` (days).
 */
export type Interval = number | `${number}${'m' | 'h' | 'd'}`;

/** Provide exactly one of `url` or `client`. */
export interface RedisConfig {
  /** Connection URL (`redis://` or `rediss://`). MailSniff creates and closes the client. */
  readonly url?: string;
  /** Your own client. MailSniff uses it but never closes it. */
  readonly client?: RedisClientLike;
  /** Prefix for every key. Default: `mailsniff:v1`. */
  readonly keyPrefix?: string;
}

export interface DatasetOptions {
  /** Where to download the blocklist from. Default: the community project's raw GitHub URL. */
  readonly sourceUrl?: string;
  /** Default: 10000. */
  readonly timeoutMs?: number;
  /** Maximum response size. Default: 2 MiB. */
  readonly maxBytes?: number;
  /** A download with fewer valid domains is rejected. Default: 500. */
  readonly minDomains?: number;
  /** Custom fetch, for proxies or tests. Default: the global `fetch`. */
  readonly fetch?: FetchLike;
}

export interface MailSniffOptions {
  /** Use Redis as the cache backend. Omit for the in-memory backend. */
  readonly redis?: RedisConfig;
  /**
   * Refresh the community list automatically at this interval (1 minute to 24 days).
   * Omit to disable automatic refresh; `refresh()` can still be called manually.
   */
  readonly refreshInterval?: Interval;
  /** Also match subdomains of listed domains (`a.mailinator.com`). Default: true. */
  readonly matchSubdomains?: boolean;
  /** Reject `init()` when startup fails instead of running degraded. Default: false. */
  readonly failOnInitError?: boolean;
  /** Receives non-fatal errors (failed downloads, Redis outages). Exceptions it throws are ignored. */
  readonly onError?: (error: Error) => void;
  readonly dataset?: DatasetOptions;
  /** Advanced: bring your own storage backend. Cannot be combined with `redis`. */
  readonly cache?: DomainCache;
}

export interface ClearCacheOptions {
  /** Also delete custom domains. Default: false. */
  readonly includeCustom?: boolean;
}

/**
 * - `updated`: a new list was downloaded and is now served.
 * - `not-modified`: the source has not changed; the freshness timestamp was renewed.
 * - `synced`: no download was needed; data came from the shared cache (another instance
 *   refreshed it, or holds the refresh lock right now).
 * - `failed`: the previous data is still served; see `error`.
 */
export type RefreshStatus = 'updated' | 'not-modified' | 'synced' | 'failed';

export interface RefreshResult {
  readonly status: RefreshStatus;
  readonly communityCount: number;
  /** Epoch milliseconds of the community list being served, or `null` when none is loaded. */
  readonly fetchedAt: number | null;
  readonly error?: Error;
}

export type MailSniffState = 'uninitialized' | 'initializing' | 'ready' | 'degraded' | 'closed';

export interface MailSniffStatus {
  /** `degraded`: the community list is empty or the cache backend is unhealthy. Lookups still work. */
  readonly state: MailSniffState;
  readonly backend: string;
  readonly cacheHealthy: boolean;
  readonly communityCount: number;
  readonly customCount: number;
  /** Epoch milliseconds of the loaded community list, or `null` when none is loaded. */
  readonly communityFetchedAt: number | null;
  /** Whether a `refreshInterval` is configured. */
  readonly autoRefresh: boolean;
  /** Epoch milliseconds of the next scheduled refresh; `null` when none is pending or one is running. */
  readonly nextRefreshAt: number | null;
  readonly lastError: Error | null;
}
