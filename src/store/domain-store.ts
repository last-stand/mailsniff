import type { CommunitySnapshot, DomainCache } from '../cache/domain-cache';
import type { DomainMatcher } from '../domain/matcher';
import { Mutex } from '../utils/mutex';

/**
 * Keeps the in-process matcher and the cache backend coherent. Every state change runs
 * under one mutex, so a background sync can never interleave with a refresh or a custom
 * domain write and resurrect stale data.
 */
export class DomainStore {
  private readonly mutex = new Mutex();
  private knownVersion: string | null = null;
  private currentEtag: string | undefined;
  private currentFetchedAt: number | null = null;

  constructor(
    private readonly cache: DomainCache,
    private readonly matcher: DomainMatcher,
  ) {}

  /** ETag of the community list being served. */
  get etag(): string | undefined {
    return this.currentEtag;
  }

  /** Download time of the community list being served, or `null` when none is loaded. */
  get fetchedAt(): number | null {
    return this.currentFetchedAt;
  }

  /** Replaces local state with what the cache holds. */
  load(): Promise<void> {
    return this.mutex.runExclusive(async () => {
      await this.reload(await this.cache.getVersion());
    });
  }

  /** Reloads only when the backend's version token differs. @returns whether it reloaded. */
  syncIfChanged(): Promise<boolean> {
    return this.mutex.runExclusive(async () => {
      const version = await this.cache.getVersion();
      if (version === this.knownVersion) {
        return false;
      }
      await this.reload(version);
      return true;
    });
  }

  /**
   * Serves a validated community list, then persists it. The list is served even when
   * persisting fails (the error is then rethrown), because the data is already validated.
   */
  applyCommunity(snapshot: CommunitySnapshot): Promise<void> {
    return this.mutex.runExclusive(async () => {
      this.matcher.replaceCommunity(snapshot.domains);
      this.currentEtag = snapshot.etag;
      this.currentFetchedAt = snapshot.fetchedAt;
      await this.cache.setCommunity(snapshot);
    });
  }

  /** Backend first: when the write fails, local state is left untouched. */
  addCustom(domains: readonly string[]): Promise<void> {
    return this.mutex.runExclusive(async () => {
      await this.cache.addCustomDomains(domains);
      this.matcher.addCustom(domains);
    });
  }

  removeCustom(domains: readonly string[]): Promise<void> {
    return this.mutex.runExclusive(async () => {
      await this.cache.removeCustomDomains(domains);
      this.matcher.removeCustom(domains);
    });
  }

  clear(includeCustom: boolean): Promise<void> {
    return this.mutex.runExclusive(async () => {
      await this.cache.clear({ includeCustom });
      this.matcher.replaceCommunity([]);
      if (includeCustom) {
        this.matcher.replaceCustom([]);
      }
      this.currentEtag = undefined;
      this.currentFetchedAt = null;
    });
  }

  /**
   * `version` must have been read before the data: a write that lands mid-reload then
   * triggers one more reload on the next check instead of being missed.
   */
  private async reload(version: string | null): Promise<void> {
    const [snapshot, custom] = await Promise.all([
      this.cache.getCommunity(),
      this.cache.getCustomDomains(),
    ]);

    if (snapshot) {
      this.matcher.replaceCommunity(snapshot.domains);
      this.currentEtag = snapshot.etag;
      this.currentFetchedAt = snapshot.fetchedAt;
    }
    this.matcher.replaceCustom(custom);
    this.knownVersion = version;
  }
}
