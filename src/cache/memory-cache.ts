import type { CommunitySnapshot, DomainCache, RefreshLock } from './domain-cache';

/** Process-local backend. Used when Redis is not configured. */
export class MemoryCache implements DomainCache {
  readonly kind = 'memory' as const;

  private community: CommunitySnapshot | null = null;
  private readonly custom = new Set<string>();
  private version = 0;
  private lock: { token: symbol; expiresAt: number } | null = null;

  connect(): Promise<void> {
    return Promise.resolve();
  }

  getCommunity(): Promise<CommunitySnapshot | null> {
    return Promise.resolve(this.community ? this.copy(this.community) : null);
  }

  setCommunity(snapshot: CommunitySnapshot): Promise<void> {
    this.community = this.copy(snapshot);
    this.version += 1;
    return Promise.resolve();
  }

  getCustomDomains(): Promise<string[]> {
    return Promise.resolve([...this.custom]);
  }

  addCustomDomains(domains: readonly string[]): Promise<void> {
    const sizeBefore = this.custom.size;
    for (const domain of domains) {
      this.custom.add(domain);
    }
    if (this.custom.size !== sizeBefore) {
      this.version += 1;
    }
    return Promise.resolve();
  }

  removeCustomDomains(domains: readonly string[]): Promise<void> {
    let changed = false;
    for (const domain of domains) {
      changed = this.custom.delete(domain) || changed;
    }
    if (changed) {
      this.version += 1;
    }
    return Promise.resolve();
  }

  getVersion(): Promise<string | null> {
    return Promise.resolve(this.version === 0 ? null : String(this.version));
  }

  acquireRefreshLock(ttlMs: number): Promise<RefreshLock | null> {
    const now = Date.now();
    if (this.lock && this.lock.expiresAt > now) {
      return Promise.resolve(null);
    }

    const token = Symbol('refresh-lock');
    this.lock = { token, expiresAt: now + ttlMs };

    return Promise.resolve({
      release: (): Promise<void> => {
        // A holder whose lock already expired must not release a newer holder's lock.
        if (this.lock?.token === token) {
          this.lock = null;
        }
        return Promise.resolve();
      },
    });
  }

  clear(options: { includeCustom: boolean }): Promise<void> {
    this.community = null;
    if (options.includeCustom) {
      this.custom.clear();
    }
    this.version += 1;
    return Promise.resolve();
  }

  isHealthy(): boolean {
    return true;
  }

  close(): Promise<void> {
    this.community = null;
    this.custom.clear();
    this.lock = null;
    return Promise.resolve();
  }

  private copy(snapshot: CommunitySnapshot): CommunitySnapshot {
    return { ...snapshot, domains: [...snapshot.domains] };
  }
}
