/** The community-maintained list as stored in a cache backend. */
export interface CommunitySnapshot {
  readonly domains: readonly string[];
  readonly etag?: string;
  /** Epoch milliseconds of the download that produced this snapshot. */
  readonly fetchedAt: number;
}

export interface RefreshLock {
  /** Best-effort: never throws, the lock also expires on its own. */
  release(): Promise<void>;
}

/**
 * Storage backend contract. Implementations must be safe for concurrent use and must
 * never mix community and custom domains: refreshing one must not alter the other.
 * Ordering of returned arrays is unspecified.
 */
export interface DomainCache {
  readonly kind: string;

  /** Prepares the backend. Rejects when it cannot be reached. */
  connect(): Promise<void>;

  getCommunity(): Promise<CommunitySnapshot | null>;
  /** Atomically replaces the whole community snapshot. */
  setCommunity(snapshot: CommunitySnapshot): Promise<void>;

  getCustomDomains(): Promise<string[]>;
  addCustomDomains(domains: readonly string[]): Promise<void>;
  removeCustomDomains(domains: readonly string[]): Promise<void>;

  /** Opaque token that changes whenever any stored data changes; `null` when nothing was ever written. */
  getVersion(): Promise<string | null>;

  /** Returns `null` when another holder owns an unexpired lock. */
  acquireRefreshLock(ttlMs: number): Promise<RefreshLock | null>;

  /** Removes the community snapshot, and the custom domains only when `includeCustom` is set. */
  clear(options: { includeCustom: boolean }): Promise<void>;

  isHealthy(): boolean;
  close(): Promise<void>;
}
