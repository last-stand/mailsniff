import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCache } from '../../../src/cache/memory-cache';

const snapshot = { domains: ['a.com', 'b.com'], etag: '"v1"', fetchedAt: 1000 };

describe('MemoryCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is healthy, connects without effort and identifies itself', async () => {
    const cache = new MemoryCache();

    await expect(cache.connect()).resolves.toBeUndefined();
    expect(cache.isHealthy()).toBe(true);
    expect(cache.kind).toBe('memory');
  });

  it('returns null before any snapshot is stored', async () => {
    await expect(new MemoryCache().getCommunity()).resolves.toBeNull();
  });

  it('stores and returns the community snapshot', async () => {
    const cache = new MemoryCache();
    await cache.setCommunity(snapshot);

    await expect(cache.getCommunity()).resolves.toEqual(snapshot);
  });

  it('isolates stored data from outside mutation', async () => {
    const cache = new MemoryCache();
    const input = { ...snapshot, domains: [...snapshot.domains] };
    await cache.setCommunity(input);
    input.domains.push('mutated.com');

    const first = await cache.getCommunity();
    (first!.domains as string[]).push('also-mutated.com');

    expect((await cache.getCommunity())!.domains).toEqual(['a.com', 'b.com']);
  });

  it('replaces the previous snapshot entirely', async () => {
    const cache = new MemoryCache();
    await cache.setCommunity(snapshot);
    await cache.setCommunity({ domains: ['c.com'], fetchedAt: 2000 });

    await expect(cache.getCommunity()).resolves.toEqual({ domains: ['c.com'], fetchedAt: 2000 });
  });

  it('adds custom domains without duplicates and removes them', async () => {
    const cache = new MemoryCache();
    await cache.addCustomDomains(['x.test', 'y.test', 'x.test']);
    await cache.removeCustomDomains(['x.test', 'unknown.test']);

    await expect(cache.getCustomDomains()).resolves.toEqual(['y.test']);
  });

  it('clear() keeps custom domains by default', async () => {
    const cache = new MemoryCache();
    await cache.setCommunity(snapshot);
    await cache.addCustomDomains(['x.test']);
    await cache.clear({ includeCustom: false });

    await expect(cache.getCommunity()).resolves.toBeNull();
    await expect(cache.getCustomDomains()).resolves.toEqual(['x.test']);
  });

  it('clear({ includeCustom }) removes everything', async () => {
    const cache = new MemoryCache();
    await cache.setCommunity(snapshot);
    await cache.addCustomDomains(['x.test']);
    await cache.clear({ includeCustom: true });

    await expect(cache.getCommunity()).resolves.toBeNull();
    await expect(cache.getCustomDomains()).resolves.toEqual([]);
  });

  describe('version', () => {
    it('is null until something is written', async () => {
      await expect(new MemoryCache().getVersion()).resolves.toBeNull();
    });

    it('changes on every real change', async () => {
      const cache = new MemoryCache();
      const versions: Array<string | null> = [];

      await cache.setCommunity(snapshot);
      versions.push(await cache.getVersion());
      await cache.addCustomDomains(['x.test']);
      versions.push(await cache.getVersion());
      await cache.removeCustomDomains(['x.test']);
      versions.push(await cache.getVersion());
      await cache.clear({ includeCustom: false });
      versions.push(await cache.getVersion());

      expect(new Set(versions).size).toBe(4);
    });

    it('does not change on no-op writes', async () => {
      const cache = new MemoryCache();
      await cache.addCustomDomains(['x.test']);
      const before = await cache.getVersion();

      await cache.addCustomDomains(['x.test']);
      await cache.removeCustomDomains(['not-there.test']);

      await expect(cache.getVersion()).resolves.toBe(before);
    });
  });

  describe('refresh lock', () => {
    it('is exclusive until released', async () => {
      const cache = new MemoryCache();
      const lock = await cache.acquireRefreshLock(1000);

      expect(lock).not.toBeNull();
      await expect(cache.acquireRefreshLock(1000)).resolves.toBeNull();

      await lock!.release();

      await expect(cache.acquireRefreshLock(1000)).resolves.not.toBeNull();
    });

    it('expires after its TTL', async () => {
      vi.useFakeTimers();
      const cache = new MemoryCache();
      await cache.acquireRefreshLock(1000);

      vi.advanceTimersByTime(1001);

      await expect(cache.acquireRefreshLock(1000)).resolves.not.toBeNull();
    });

    it('does not let an expired holder release a newer lock', async () => {
      vi.useFakeTimers();
      const cache = new MemoryCache();
      const stale = await cache.acquireRefreshLock(1000);
      vi.advanceTimersByTime(1001);
      await cache.acquireRefreshLock(1000);

      await stale!.release();

      await expect(cache.acquireRefreshLock(1000)).resolves.toBeNull();
    });
  });

  it('close() discards everything', async () => {
    const cache = new MemoryCache();
    await cache.setCommunity(snapshot);
    await cache.addCustomDomains(['x.test']);
    await cache.close();

    await expect(cache.getCommunity()).resolves.toBeNull();
    await expect(cache.getCustomDomains()).resolves.toEqual([]);
  });
});
