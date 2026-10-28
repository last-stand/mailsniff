import type { CommunitySnapshot, DomainCache, RefreshLock } from '../cache/domain-cache';
import type { ResolvedDatasetOptions } from '../config/options';
import { PEER_POLL_INTERVAL_MS } from '../constants';
import { fetchDataset } from '../dataset/fetcher';
import { assertNotShrunk } from '../dataset/guards';
import { parseBlocklist } from '../dataset/parser';
import type { DomainMatcher } from '../domain/matcher';
import { DatasetError } from '../errors';
import type { DomainStore } from '../store/domain-store';
import type { RefreshResult, RefreshStatus } from '../types';
import { toError } from '../utils/error';
import { sleep as defaultSleep } from '../utils/sleep';

export interface RefresherOptions {
  readonly cache: DomainCache;
  readonly store: DomainStore;
  readonly matcher: DomainMatcher;
  readonly dataset: ResolvedDatasetOptions;
  readonly lockTtlMs: number;
  /** How long to wait for a peer that holds the lock when nothing is loaded yet. */
  readonly peerWaitMs: number;
  /** Non-forced refreshes skip the download when the shared snapshot is younger than this. */
  readonly freshnessMs?: number;
  /** Receives every failure. Must not throw. */
  readonly onError: (error: Error) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

type LockAttempt =
  | { readonly kind: 'acquired'; readonly lock: RefreshLock }
  | { readonly kind: 'busy' }
  | { readonly kind: 'unavailable' };

/**
 * Downloads, validates and applies the community list.
 *
 * - One refresh at a time per instance: concurrent callers share the same run.
 * - One refresh at a time across instances sharing a backend (lock).
 * - Never rejects: failures are reported and returned, and the previous data stays active.
 */
export class CommunityRefresher {
  private inflight: Promise<RefreshResult> | undefined;

  constructor(private readonly options: RefresherOptions) {}

  /**
   * @param options.force download even when the shared snapshot is recent (manual refresh).
   *   Scheduled refreshes pass `false`.
   */
  refresh(options: { force: boolean }): Promise<RefreshResult> {
    this.inflight ??= this.run(options.force).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** Resolves once no refresh is running. */
  async idle(): Promise<void> {
    await this.inflight;
  }

  private async run(force: boolean): Promise<RefreshResult> {
    const attempt = await this.acquireLock();
    if (attempt.kind === 'busy') {
      return this.followPeer();
    }

    try {
      return await this.refreshFromSource(force, attempt.kind === 'acquired');
    } catch (error) {
      return this.fail(error);
    } finally {
      if (attempt.kind === 'acquired') {
        await attempt.lock.release();
      }
    }
  }

  private async acquireLock(): Promise<LockAttempt> {
    // An unhealthy backend cannot coordinate anything. The outage was already reported,
    // so skip it quietly and refresh this instance's own data.
    if (!this.options.cache.isHealthy()) {
      return { kind: 'unavailable' };
    }

    try {
      const lock = await this.options.cache.acquireRefreshLock(this.options.lockTtlMs);
      return lock ? { kind: 'acquired', lock } : { kind: 'busy' };
    } catch (error) {
      // Without a working lock this instance can still refresh its own data.
      this.options.onError(toError(error));
      return { kind: 'unavailable' };
    }
  }

  /** Another instance is refreshing: adopt its result instead of downloading again. */
  private async followPeer(): Promise<RefreshResult> {
    const { matcher, store, peerWaitMs } = this.options;
    const sleep = this.options.sleep ?? defaultSleep;

    try {
      await store.syncIfChanged();

      // With nothing to serve yet, wait for the peer's download to land in the cache.
      const attempts = Math.ceil(peerWaitMs / PEER_POLL_INTERVAL_MS);
      for (let attempt = 0; attempt < attempts && matcher.communityCount === 0; attempt += 1) {
        await sleep(PEER_POLL_INTERVAL_MS);
        await store.syncIfChanged();
      }
      return this.result('synced');
    } catch (error) {
      return this.fail(error);
    }
  }

  private async refreshFromSource(force: boolean, shared: boolean): Promise<RefreshResult> {
    const { matcher, store, dataset } = this.options;

    // Checked after taking the lock, so a peer that just finished is not downloaded again.
    if (shared && (await this.adoptSharedSnapshot(force))) {
      return this.result('synced');
    }

    const previousCount = matcher.communityCount;
    const response = await fetchDataset({
      url: dataset.sourceUrl,
      timeoutMs: dataset.timeoutMs,
      maxBytes: dataset.maxBytes,
      fetch: dataset.fetch,
      // A 304 is only usable when there is a list to keep serving.
      etag: previousCount > 0 ? store.etag : undefined,
    });
    const fetchedAt = this.now();

    if (response.status === 'not-modified') {
      if (matcher.communityCount === 0) {
        throw new DatasetError('The dataset source reported "not modified" but nothing is loaded');
      }
      await this.persist({ domains: matcher.listCommunity(), etag: store.etag, fetchedAt });
      return this.result('not-modified');
    }

    const domains = parseBlocklist(response.body, { minDomains: dataset.minDomains });
    assertNotShrunk(previousCount, domains.length);
    await this.persist({ domains, etag: response.etag, fetchedAt });
    return this.result('updated');
  }

  /**
   * Scheduled refresh: adopt a shared snapshot that is still fresh.
   * Manual refresh: adopt one only when nothing is loaded locally.
   */
  private async adoptSharedSnapshot(force: boolean): Promise<boolean> {
    const { cache, matcher, store } = this.options;

    const snapshot = await cache.getCommunity();
    if (!snapshot) {
      return false;
    }

    const usable = force ? matcher.communityCount === 0 : this.isFresh(snapshot.fetchedAt);
    if (!usable) {
      return false;
    }

    await store.load();
    return true;
  }

  private isFresh(fetchedAt: number): boolean {
    const { freshnessMs } = this.options;
    if (freshnessMs === undefined) {
      return false;
    }
    // A negative age means another machine's clock is ahead; never trust it to skip refreshes.
    const age = this.now() - fetchedAt;
    return age >= 0 && age < freshnessMs;
  }

  /** The list is served even when persisting fails; the failure is only reported. */
  private async persist(snapshot: CommunitySnapshot): Promise<void> {
    try {
      await this.options.store.applyCommunity(snapshot);
    } catch (error) {
      this.options.onError(toError(error));
    }
  }

  private fail(error: unknown): RefreshResult {
    const failure = toError(error);
    this.options.onError(failure);
    return this.result('failed', failure);
  }

  private result(status: RefreshStatus, error?: Error): RefreshResult {
    return {
      status,
      communityCount: this.options.matcher.communityCount,
      fetchedAt: this.options.store.fetchedAt,
      ...(error ? { error } : {}),
    };
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
