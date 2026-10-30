import { describe, expect, it, vi } from 'vitest';
import { MemoryCache } from '../../../src/cache/memory-cache';
import { DomainMatcher } from '../../../src/domain/matcher';
import { CacheError } from '../../../src/errors';
import { DomainStore } from '../../../src/store/domain-store';
import { createDeferred } from '../../helpers/deferred';

function setup() {
  const cache = new MemoryCache();
  const matcher = new DomainMatcher(true);
  const store = new DomainStore(cache, matcher);
  return { cache, matcher, store };
}

describe('DomainStore', () => {
  describe('load', () => {
    it('adopts the cached community list and custom domains', async () => {
      const { cache, matcher, store } = setup();
      await cache.setCommunity({ domains: ['a.test'], etag: '"e"', fetchedAt: 5 });
      await cache.addCustomDomains(['c.test']);
      await store.load();

      expect(matcher.matches('a.test')).toBe(true);
      expect(matcher.matches('c.test')).toBe(true);
      expect(store.etag).toBe('"e"');
      expect(store.fetchedAt).toBe(5);
    });

    it('keeps the current community list when the cache has none', async () => {
      const { matcher, store } = setup();
      matcher.replaceCommunity(['kept.test']);
      await store.load();

      expect(matcher.matches('kept.test')).toBe(true);
      expect(store.fetchedAt).toBeNull();
    });
  });

  describe('syncIfChanged', () => {
    it('does nothing while the version is unchanged', async () => {
      const { store } = setup();
      await store.load();

      await expect(store.syncIfChanged()).resolves.toBe(false);
    });

    it('reloads after another writer changed the backend, once', async () => {
      const { cache, matcher, store } = setup();
      await store.load();
      await cache.addCustomDomains(['x.test']);

      await expect(store.syncIfChanged()).resolves.toBe(true);
      expect(matcher.matches('x.test')).toBe(true);
      await expect(store.syncIfChanged()).resolves.toBe(false);
    });

    it('reads the version once per check, whether or not it reloads', async () => {
      const { cache, store } = setup();
      await store.load();
      const getVersion = vi.spyOn(cache, 'getVersion');

      await store.syncIfChanged();
      expect(getVersion).toHaveBeenCalledTimes(1);

      await cache.addCustomDomains(['x.test']);
      getVersion.mockClear();
      await store.syncIfChanged();
      expect(getVersion).toHaveBeenCalledTimes(1);
    });

    it('sees its own writes as a change and reloads harmlessly once', async () => {
      const { matcher, store } = setup();
      await store.load();
      await store.addCustom(['mine.test']);

      await expect(store.syncIfChanged()).resolves.toBe(true);
      expect(matcher.matches('mine.test')).toBe(true);
      await expect(store.syncIfChanged()).resolves.toBe(false);
    });

    it('propagates backend failures', async () => {
      const { cache, store } = setup();
      vi.spyOn(cache, 'getVersion').mockRejectedValue(new CacheError('down'));

      await expect(store.syncIfChanged()).rejects.toBeInstanceOf(CacheError);
    });
  });

  describe('applyCommunity', () => {
    it('serves and persists the snapshot without touching custom domains', async () => {
      const { cache, matcher, store } = setup();
      await store.addCustom(['mine.test']);
      await store.applyCommunity({ domains: ['a.test'], etag: '"x"', fetchedAt: 9 });

      expect(matcher.matches('a.test')).toBe(true);
      expect(matcher.matches('mine.test')).toBe(true);
      expect(store.etag).toBe('"x"');
      expect(await cache.getCommunity()).toEqual({
        domains: ['a.test'],
        etag: '"x"',
        fetchedAt: 9,
      });
    });

    it('still serves the list when persisting fails, and rethrows', async () => {
      const { cache, matcher, store } = setup();
      vi.spyOn(cache, 'setCommunity').mockRejectedValue(new CacheError('down'));

      await expect(
        store.applyCommunity({ domains: ['a.test'], etag: '"x"', fetchedAt: 9 }),
      ).rejects.toBeInstanceOf(CacheError);
      expect(matcher.matches('a.test')).toBe(true);
      expect(store.fetchedAt).toBe(9);
    });

    it('waits for a reload in progress, so stale data cannot overwrite it', async () => {
      const { cache, matcher, store } = setup();
      const gate = createDeferred();
      vi.spyOn(cache, 'getCommunity').mockImplementationOnce(async () => {
        await gate.promise;
        return { domains: ['old.test'], fetchedAt: 1 };
      });

      const loading = store.load();
      const applying = store.applyCommunity({ domains: ['new.test'], fetchedAt: 2 });
      gate.resolve();
      await Promise.all([loading, applying]);

      expect(matcher.matches('new.test')).toBe(true);
      expect(matcher.matches('old.test')).toBe(false);
    });
  });

  describe('custom domains', () => {
    it('adds and removes in the backend and locally', async () => {
      const { cache, matcher, store } = setup();
      await store.addCustom(['a.test', 'b.test']);
      await store.removeCustom(['a.test']);

      expect(matcher.matches('a.test')).toBe(false);
      expect(matcher.matches('b.test')).toBe(true);
      expect(await cache.getCustomDomains()).toEqual(['b.test']);
    });

    it('leaves local state untouched when the backend rejects the write', async () => {
      const { cache, matcher, store } = setup();
      vi.spyOn(cache, 'addCustomDomains').mockRejectedValue(new CacheError('down'));

      await expect(store.addCustom(['x.test'])).rejects.toBeInstanceOf(CacheError);
      expect(matcher.matches('x.test')).toBe(false);
    });

    it('does not remove locally when the backend rejects the removal', async () => {
      const { cache, matcher, store } = setup();
      await store.addCustom(['x.test']);
      vi.spyOn(cache, 'removeCustomDomains').mockRejectedValue(new CacheError('down'));

      await expect(store.removeCustom(['x.test'])).rejects.toBeInstanceOf(CacheError);
      expect(matcher.matches('x.test')).toBe(true);
    });
  });

  describe('write-back after a failed persist', () => {
    const snapshot = { domains: ['a.test'], etag: '"x"', fetchedAt: 9 };

    it('writes the served list to the backend on the next sync', async () => {
      const { cache, store } = setup();
      const setCommunity = vi
        .spyOn(cache, 'setCommunity')
        .mockRejectedValueOnce(new CacheError('down'));
      await expect(store.applyCommunity(snapshot)).rejects.toBeInstanceOf(CacheError);
      expect(await cache.getCommunity()).toBeNull();

      await store.syncIfChanged();

      expect(await cache.getCommunity()).toEqual(snapshot);
      expect(setCommunity).toHaveBeenCalledTimes(2);
    });

    it('keeps retrying while the backend is still failing', async () => {
      const { cache, store } = setup();
      const failing = vi.spyOn(cache, 'setCommunity').mockRejectedValue(new CacheError('down'));
      await store.applyCommunity(snapshot).catch(() => undefined);

      await expect(store.syncIfChanged()).rejects.toBeInstanceOf(CacheError);

      failing.mockRestore();
      await store.syncIfChanged();
      expect(await cache.getCommunity()).toEqual(snapshot);
    });

    it('does not overwrite a newer list stored by another instance, and adopts it', async () => {
      const { cache, matcher, store } = setup();
      vi.spyOn(cache, 'setCommunity').mockRejectedValueOnce(new CacheError('down'));
      await store.applyCommunity(snapshot).catch(() => undefined);
      await cache.setCommunity({ domains: ['peer.test'], fetchedAt: 20 });

      await store.syncIfChanged();

      expect(await cache.getCommunity()).toEqual({ domains: ['peer.test'], fetchedAt: 20 });
      expect(matcher.matches('peer.test')).toBe(true);
    });

    it('is dropped by clear()', async () => {
      const { cache, store } = setup();
      vi.spyOn(cache, 'setCommunity').mockRejectedValueOnce(new CacheError('down'));
      await store.applyCommunity(snapshot).catch(() => undefined);
      await store.clear(false);

      await store.syncIfChanged();

      expect(await cache.getCommunity()).toBeNull();
    });

    it('does nothing when every write succeeded', async () => {
      const { cache, store } = setup();
      await store.applyCommunity(snapshot);
      const setCommunity = vi.spyOn(cache, 'setCommunity');

      await store.syncIfChanged();

      expect(setCommunity).not.toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('keeps custom domains by default and resets the list metadata', async () => {
      const { matcher, store } = setup();
      await store.addCustom(['mine.test']);
      await store.applyCommunity({ domains: ['a.test'], etag: '"x"', fetchedAt: 9 });
      await store.clear(false);

      expect(matcher.matches('a.test')).toBe(false);
      expect(matcher.matches('mine.test')).toBe(true);
      expect(store.etag).toBeUndefined();
      expect(store.fetchedAt).toBeNull();
    });

    it('removes custom domains with includeCustom', async () => {
      const { cache, matcher, store } = setup();
      await store.addCustom(['mine.test']);
      await store.clear(true);

      expect(matcher.matches('mine.test')).toBe(false);
      expect(await cache.getCustomDomains()).toEqual([]);
    });

    it('leaves local state untouched when the backend rejects the clear', async () => {
      const { cache, matcher, store } = setup();
      await store.applyCommunity({ domains: ['a.test'], fetchedAt: 9 });
      vi.spyOn(cache, 'clear').mockRejectedValue(new CacheError('down'));

      await expect(store.clear(true)).rejects.toBeInstanceOf(CacheError);
      expect(matcher.matches('a.test')).toBe(true);
    });
  });
});
