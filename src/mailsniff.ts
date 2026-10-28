import type { DomainCache } from './cache/domain-cache';
import { MemoryCache } from './cache/memory-cache';
import { RedisCache } from './cache/redis-cache';
import { resolveOptions } from './config/options';
import type { ResolvedOptions } from './config/options';
import {
  DEFAULT_REFRESH_LOCK_TTL_MS,
  PEER_WAIT_MARGIN_MS,
  REFRESH_FRESHNESS_RATIO,
  REFRESH_INITIAL_BACKOFF_MS,
  REFRESH_LOCK_TIMEOUT_MARGIN_MS,
  VERSION_CHECK_INTERVAL_MS,
} from './constants';
import { DomainMatcher } from './domain/matcher';
import { extractEmailDomain, normalizeDomain, normalizeDomains } from './domain/normalize';
import { ClosedError, ConfigError } from './errors';
import { CommunityRefresher } from './refresh/refresher';
import { RefreshScheduler } from './refresh/scheduler';
import { DomainStore } from './store/domain-store';
import type {
  ClearCacheOptions,
  MailSniffOptions,
  MailSniffState,
  MailSniffStatus,
  RefreshResult,
} from './types';
import { toError } from './utils/error';

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string`);
  }
}

function toDomainList(input: unknown): readonly unknown[] {
  if (typeof input === 'string') {
    return [input];
  }
  if (Array.isArray(input)) {
    return input as readonly unknown[];
  }
  throw new TypeError('domains must be a string or an array of strings');
}

/**
 * Detects disposable email addresses and domains.
 *
 * Lookups run against an in-process snapshot, so after initialization they perform no I/O
 * regardless of the cache backend. The backend is only used to share and persist data;
 * changes made by other instances are picked up by a throttled background check.
 */
export class MailSniff {
  private readonly options: ResolvedOptions;
  private readonly cache: DomainCache;
  private readonly matcher: DomainMatcher;
  private readonly store: DomainStore;
  private readonly refresher: CommunityRefresher;
  private readonly scheduler: RefreshScheduler | undefined;

  private initPromise: Promise<void> | undefined;
  private syncPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private initialized = false;
  private initializing = false;
  private closed = false;
  private lastVersionCheck = 0;
  private lastError: Error | null = null;
  private initialDownload: RefreshResult | undefined;

  /** @throws {ConfigError} when `options` are invalid. Nothing is fetched or connected yet. */
  constructor(options: MailSniffOptions = {}) {
    this.options = resolveOptions(options);
    this.matcher = new DomainMatcher(this.options.matchSubdomains);
    this.cache =
      this.options.cache ??
      (this.options.redis
        ? new RedisCache({ ...this.options.redis, onError: this.reportError })
        : new MemoryCache());
    this.store = new DomainStore(this.cache, this.matcher);

    const { dataset, refreshIntervalMs } = this.options;
    this.refresher = new CommunityRefresher({
      cache: this.cache,
      store: this.store,
      matcher: this.matcher,
      dataset,
      lockTtlMs: Math.max(
        DEFAULT_REFRESH_LOCK_TTL_MS,
        dataset.timeoutMs + REFRESH_LOCK_TIMEOUT_MARGIN_MS,
      ),
      peerWaitMs: dataset.timeoutMs + PEER_WAIT_MARGIN_MS,
      freshnessMs:
        refreshIntervalMs === undefined ? undefined : refreshIntervalMs * REFRESH_FRESHNESS_RATIO,
      onError: this.reportError,
    });

    this.scheduler =
      refreshIntervalMs === undefined
        ? undefined
        : new RefreshScheduler({
            intervalMs: refreshIntervalMs,
            initialBackoffMs: REFRESH_INITIAL_BACKOFF_MS,
            task: async () => (await this.refresher.refresh({ force: false })).status !== 'failed',
          });
  }

  /**
   * Connects the cache and loads the dataset. Called automatically by the first lookup,
   * so calling it is optional (for example to warm up at application start).
   * Resolves even when the network or Redis is down, unless `failOnInitError` is set.
   * Starts the refresh schedule when `refreshInterval` is configured.
   * @throws {ConfigError} always, for configuration problems such as a missing `ioredis`.
   */
  init(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new ClosedError());
    }

    this.initPromise ??= this.runInit().then(
      () => {
        this.initialized = true;
      },
      (error: unknown) => {
        // Allow a later call to retry.
        this.initPromise = undefined;
        throw error;
      },
    );
    return this.initPromise;
  }

  /**
   * @returns `false` for invalid or malformed addresses.
   * @throws {TypeError} when `email` is not a string.
   */
  async isDisposableEmail(email: string): Promise<boolean> {
    assertString(email, 'email');
    await this.ensureReady();

    const domain = extractEmailDomain(email);
    return domain !== null && this.matcher.matches(domain);
  }

  /**
   * @returns `false` for invalid domains.
   * @throws {TypeError} when `domain` is not a string.
   */
  async isDisposableDomain(domain: string): Promise<boolean> {
    assertString(domain, 'domain');
    await this.ensureReady();

    const normalized = normalizeDomain(domain);
    return normalized !== null && this.matcher.matches(normalized);
  }

  /** Sorted, de-duplicated community and custom domains. */
  async listDisposableDomains(): Promise<string[]> {
    await this.ensureReady();
    return this.matcher.list();
  }

  /**
   * Adds custom disposable domains. With Redis they are persisted and shared; with the
   * in-memory backend they last for the lifetime of the process. All-or-nothing.
   * Community refreshes never touch them.
   * @throws {ValidationError} when any entry is invalid.
   * @throws {CacheError} when the backend rejects the write; nothing is changed locally.
   */
  async addDisposableDomains(domains: string | readonly string[]): Promise<void> {
    const normalized = normalizeDomains(toDomainList(domains));
    await this.ensureReady();
    if (normalized.length > 0) {
      await this.store.addCustom(normalized);
    }
  }

  /**
   * Removes custom domains. Community domains cannot be removed, and unknown entries are ignored.
   * @throws {ValidationError} when any entry is invalid.
   * @throws {CacheError} when the backend rejects the write.
   */
  async removeDisposableDomains(domains: string | readonly string[]): Promise<void> {
    const normalized = normalizeDomains(toDomainList(domains));
    await this.ensureReady();
    if (normalized.length > 0) {
      await this.store.removeCustom(normalized);
    }
  }

  /**
   * Downloads the community list now, regardless of the refresh schedule.
   *
   * How it works:
   * 1. Initializes the instance first if needed (connects the cache, loads or downloads data).
   * 2. If this call triggered initialization and that already downloaded the list, returns
   *    that result instead of downloading a second time.
   * 3. Otherwise runs a forced refresh. Concurrent calls share one download, and instances
   *    sharing Redis coordinate through a lock. A call that loses the lock waits for the
   *    peer's result and resolves with status `synced`.
   * 4. Downloads are validated (format, minimum size, shrink guard) before being served.
   *    Custom domains are never touched.
   *
   * Operational failures (network, invalid dataset, cache outage) are returned as
   * `status: 'failed'` and reported through `onError`, never thrown. The previous data
   * keeps being served.
   *
   * @throws {ClosedError} after `close()`.
   * @throws {ConfigError} for configuration problems found during initialization, such as a missing `ioredis`.
   */
  async refresh(): Promise<RefreshResult> {
    const wasInitialized = this.initialized;
    await this.ensureReady();

    // This call triggered (or joined) initialization, which just downloaded the list.
    // Downloading again would be wasted work.
    if (!wasInitialized && this.initialDownload) {
      return this.initialDownload;
    }
    return this.refresher.refresh({ force: true });
  }

  /**
   * Clears the stored community list (and custom domains with `includeCustom`), then
   * re-downloads the community list. A failed download is reported through `onError`.
   * @throws {CacheError} when the backend cannot be cleared; nothing is changed locally.
   */
  async clearCache(options: ClearCacheOptions = {}): Promise<void> {
    await this.ensureReady();
    await this.refresher.idle();
    await this.store.clear(options.includeCustom ?? false);
    await this.refresher.refresh({ force: true });
  }

  /** Synchronous snapshot of the instance's health. Never throws. */
  status(): MailSniffStatus {
    return {
      state: this.currentState(),
      backend: this.cache.kind,
      cacheHealthy: this.cache.isHealthy(),
      communityCount: this.matcher.communityCount,
      customCount: this.matcher.customCount,
      communityFetchedAt: this.store.fetchedAt,
      autoRefresh: this.scheduler !== undefined,
      nextRefreshAt: this.scheduler?.nextRunAt ?? null,
      lastError: this.lastError,
    };
  }

  /**
   * Stops the refresh schedule, waits for in-flight work and releases resources. Redis
   * clients created by MailSniff are closed; clients you passed in are left open.
   * Idempotent. Any later call rejects with `ClosedError`.
   */
  close(): Promise<void> {
    this.closePromise ??= this.shutdown();
    return this.closePromise;
  }

  private async shutdown(): Promise<void> {
    this.closed = true;

    // Order matters: let init finish (it must not start the scheduler once closed),
    // then stop the scheduler, then wait for whatever it left running.
    await Promise.allSettled([this.initPromise]);
    await this.scheduler?.stop();
    await Promise.allSettled([this.refresher.idle(), this.syncPromise]);

    try {
      await this.cache.close();
    } catch (error) {
      this.reportError(toError(error));
    }
  }

  private ensureReady(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new ClosedError());
    }
    if (this.initialized) {
      this.maybeSync();
      return Promise.resolve();
    }
    return this.init();
  }

  private async runInit(): Promise<void> {
    this.initializing = true;
    try {
      let connected = false;
      await this.tolerate(async () => {
        await this.cache.connect();
        connected = true;
      });

      if (connected) {
        await this.tolerate(() => this.store.load());
      }
      if (!this.matcher.hasCommunity) {
        await this.downloadInitialCommunity();
      }

      this.lastVersionCheck = Date.now();
      this.startScheduler();
    } finally {
      this.initializing = false;
    }
  }

  /** The refresher already reported a failure through `onError`. */
  private async downloadInitialCommunity(): Promise<void> {
    const result = await this.refresher.refresh({ force: true });
    if (result.status === 'updated') {
      this.initialDownload = result;
    }
    if (result.error && this.options.failOnInitError) {
      throw result.error;
    }
  }

  /** Reports a startup failure and continues degraded, unless `failOnInitError` is set. */
  private async tolerate(step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (error) {
      // Configuration mistakes are never silenced.
      if (error instanceof ConfigError) {
        throw error;
      }
      const failure = toError(error);
      this.reportError(failure);
      if (this.options.failOnInitError) {
        throw failure;
      }
    }
  }

  private startScheduler(): void {
    if (this.scheduler && !this.closed) {
      this.scheduler.start(this.initialRefreshDelay());
    }
  }

  /**
   * Waits until the loaded list is due for a refresh (immediately when it is already stale).
   * Without a list, retries after the base backoff delay.
   */
  private initialRefreshDelay(): number {
    const fetchedAt = this.store.fetchedAt;
    const intervalMs = this.options.refreshIntervalMs ?? 0;
    if (!this.matcher.hasCommunity || fetchedAt === null) {
      return REFRESH_INITIAL_BACKOFF_MS;
    }
    return Math.max(0, fetchedAt + intervalMs - Date.now());
  }

  /**
   * Stale-while-revalidate: at most every 30 s a lookup starts a background check for
   * changes made by other instances. The lookup itself never waits for it. It also
   * recovers from a backend outage, because the check reloads once the backend is back.
   */
  private maybeSync(): void {
    const now = Date.now();
    if (this.syncPromise || now - this.lastVersionCheck < VERSION_CHECK_INTERVAL_MS) {
      return;
    }

    this.lastVersionCheck = now;
    this.syncPromise = this.store
      .syncIfChanged()
      .then(
        () => undefined,
        (error: unknown) => {
          this.reportError(toError(error));
        },
      )
      .finally(() => {
        this.syncPromise = undefined;
      });
  }

  private currentState(): MailSniffState {
    if (this.closed) {
      return 'closed';
    }
    if (this.initializing) {
      return 'initializing';
    }
    if (!this.initialized) {
      return 'uninitialized';
    }
    return this.matcher.hasCommunity && this.cache.isHealthy() ? 'ready' : 'degraded';
  }

  private readonly reportError = (error: Error): void => {
    this.lastError = error;
    try {
      this.options.onError(error);
    } catch {
      // A throwing callback must never break detection.
    }
  };
}
