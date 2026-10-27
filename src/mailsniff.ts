import type { CommunitySnapshot, DomainCache } from './cache/domain-cache';
import { MemoryCache } from './cache/memory-cache';
import { RedisCache } from './cache/redis-cache';
import { resolveOptions } from './config/options';
import type { ResolvedOptions } from './config/options';
import { fetchDataset } from './dataset/fetcher';
import { parseBlocklist } from './dataset/parser';
import { DomainMatcher } from './domain/matcher';
import { extractEmailDomain, normalizeDomain, normalizeDomains } from './domain/normalize';
import { ClosedError, ConfigError, DatasetError } from './errors';
import type { ClearCacheOptions, MailSniffOptions, MailSniffState, MailSniffStatus } from './types';
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
 * regardless of the cache backend. The backend is only used to share and persist data.
 */
export class MailSniff {
  private readonly options: ResolvedOptions;
  private readonly cache: DomainCache;
  private readonly matcher: DomainMatcher;

  private initPromise: Promise<void> | undefined;
  private inflightLoad: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private initialized = false;
  private initializing = false;
  private closed = false;
  private communityFetchedAt: number | null = null;
  private lastError: Error | null = null;

  /** @throws {ConfigError} when `options` are invalid. Nothing is fetched or connected yet. */
  constructor(options: MailSniffOptions = {}) {
    this.options = resolveOptions(options);
    this.matcher = new DomainMatcher(this.options.matchSubdomains);
    this.cache =
      this.options.cache ??
      (this.options.redis
        ? new RedisCache({ ...this.options.redis, onError: this.reportError })
        : new MemoryCache());
  }

  /**
   * Connects the cache and loads the dataset. Called automatically by the first lookup,
   * so calling it is optional (for example to warm up at application start).
   * Resolves even when the network or Redis is down, unless `failOnInitError` is set.
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
   * @throws {ValidationError} when any entry is invalid.
   * @throws {CacheError} when the backend rejects the write; nothing is changed locally.
   */
  async addDisposableDomains(domains: string | readonly string[]): Promise<void> {
    const normalized = normalizeDomains(toDomainList(domains));
    await this.ensureReady();
    if (normalized.length === 0) {
      return;
    }

    // Write to the backend first so a failure cannot leave local state ahead of storage.
    await this.cache.addCustomDomains(normalized);
    this.matcher.addCustom(normalized);
  }

  /**
   * Removes custom domains. Community domains cannot be removed, and unknown entries are ignored.
   * @throws {ValidationError} when any entry is invalid.
   * @throws {CacheError} when the backend rejects the write.
   */
  async removeDisposableDomains(domains: string | readonly string[]): Promise<void> {
    const normalized = normalizeDomains(toDomainList(domains));
    await this.ensureReady();
    if (normalized.length === 0) {
      return;
    }

    await this.cache.removeCustomDomains(normalized);
    this.matcher.removeCustom(normalized);
  }

  /**
   * Clears the stored community list (and custom domains with `includeCustom`), then
   * re-downloads the community list. A failed download is reported through `onError`.
   * @throws {CacheError} when the backend cannot be cleared; nothing is changed locally.
   */
  async clearCache(options: ClearCacheOptions = {}): Promise<void> {
    await this.ensureReady();
    const includeCustom = options.includeCustom ?? false;

    await this.cache.clear({ includeCustom });
    this.matcher.replaceCommunity([]);
    if (includeCustom) {
      this.matcher.replaceCustom([]);
    }
    this.communityFetchedAt = null;

    try {
      await this.loadCommunity();
    } catch (error) {
      this.reportError(toError(error));
    }
  }

  /** Synchronous snapshot of the instance's health. Never throws. */
  status(): MailSniffStatus {
    return {
      state: this.currentState(),
      backend: this.cache.kind,
      cacheHealthy: this.cache.isHealthy(),
      communityCount: this.matcher.communityCount,
      customCount: this.matcher.customCount,
      communityFetchedAt: this.communityFetchedAt,
      lastError: this.lastError,
    };
  }

  /**
   * Waits for in-flight work and releases resources. Redis clients created by MailSniff are
   * closed; clients you passed in are left open. Idempotent. Any later call rejects with `ClosedError`.
   */
  close(): Promise<void> {
    this.closePromise ??= this.shutdown();
    return this.closePromise;
  }

  private async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([this.initPromise, this.inflightLoad]);

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
    return this.initialized ? Promise.resolve() : this.init();
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
        await this.tolerate(() => this.loadFromCache());
      }
      if (!this.matcher.hasCommunity) {
        await this.tolerate(() => this.loadCommunity());
      }
    } finally {
      this.initializing = false;
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

  private async loadFromCache(): Promise<void> {
    const [snapshot, custom] = await Promise.all([
      this.cache.getCommunity(),
      this.cache.getCustomDomains(),
    ]);

    if (snapshot) {
      this.matcher.replaceCommunity(snapshot.domains);
      this.communityFetchedAt = snapshot.fetchedAt;
    }
    this.matcher.replaceCustom(custom);
  }

  /** Single-flight: concurrent callers share one download. */
  private loadCommunity(): Promise<void> {
    this.inflightLoad ??= this.downloadCommunity().finally(() => {
      this.inflightLoad = undefined;
    });
    return this.inflightLoad;
  }

  private async downloadCommunity(): Promise<void> {
    const { dataset } = this.options;
    const result = await fetchDataset({
      url: dataset.sourceUrl,
      timeoutMs: dataset.timeoutMs,
      maxBytes: dataset.maxBytes,
      fetch: dataset.fetch,
    });

    if (result.status !== 'modified') {
      throw new DatasetError('The dataset source returned an unexpected "not modified" response');
    }

    // Only validated data reaches this point (parseBlocklist throws otherwise).
    const domains = parseBlocklist(result.body, { minDomains: dataset.minDomains });
    const snapshot: CommunitySnapshot = { domains, etag: result.etag, fetchedAt: Date.now() };

    // Serve the new data immediately, even if the backend is down, then try to persist it.
    this.matcher.replaceCommunity(domains);
    this.communityFetchedAt = snapshot.fetchedAt;

    try {
      await this.cache.setCommunity(snapshot);
    } catch (error) {
      this.reportError(toError(error));
    }
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
