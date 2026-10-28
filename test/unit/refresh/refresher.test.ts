import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { MemoryCache } from '../../../src/cache/memory-cache';
import type { FetchLike } from '../../../src/dataset/fetcher';
import { DomainMatcher } from '../../../src/domain/matcher';
import { CacheError, DatasetError } from '../../../src/errors';
import { CommunityRefresher } from '../../../src/refresh/refresher';
import type { RefresherOptions } from '../../../src/refresh/refresher';
import { DomainStore } from '../../../src/store/domain-store';
import { createDeferred } from '../../helpers/deferred';
import { makeResponse } from '../../helpers/fake-fetch';
import { buildBlocklist } from '../../helpers/fixtures';

const LIST_SIZE = 23; // 3 sample domains + 20 filler

function okResponse(body = buildBlocklist(), etag = '"v1"') {
  return makeResponse({ body, headers: { etag } });
}

function setup(overrides: Partial<RefresherOptions> = {}, fetch?: Mock<FetchLike>) {
  const clock = { now: 1_000_000 };
  const cache = new MemoryCache();
  const matcher = new DomainMatcher(true);
  const store = new DomainStore(cache, matcher);
  const errors: Error[] = [];
  const fetchMock = fetch ?? vi.fn<FetchLike>(() => Promise.resolve(okResponse()));
  const refresher = new CommunityRefresher({
    cache,
    store,
    matcher,
    dataset: {
      sourceUrl: 'https://example.test/list.conf',
      timeoutMs: 1000,
      maxBytes: 1_000_000,
      minDomains: 10,
      fetch: fetchMock,
    },
    lockTtlMs: 5000,
    peerWaitMs: 1000,
    freshnessMs: 1000,
    sleep: () => Promise.resolve(),
    onError: (error) => errors.push(error),
    now: () => clock.now,
    ...overrides,
  });
  return { clock, cache, matcher, store, errors, fetch: fetchMock, refresher };
}

describe('CommunityRefresher', () => {
  describe('downloading', () => {
    it('applies and persists a new list', async () => {
      const { refresher, cache, matcher, clock } = setup();
      const result = await refresher.refresh({ force: true });

      expect(result).toEqual({
        status: 'updated',
        communityCount: LIST_SIZE,
        fetchedAt: clock.now,
      });
      expect(matcher.matches('mailinator.com')).toBe(true);
      expect(await cache.getCommunity()).toMatchObject({ etag: '"v1"', fetchedAt: clock.now });
    });

    it('uses the ETag and renews the timestamp on 304 Not Modified', async () => {
      const fetch = vi
        .fn<FetchLike>()
        .mockResolvedValueOnce(okResponse())
        .mockResolvedValueOnce(makeResponse({ status: 304 }));
      const { refresher, clock, cache, matcher } = setup({}, fetch);
      await refresher.refresh({ force: true });
      clock.now += 5000;
      const result = await refresher.refresh({ force: true });

      expect(fetch.mock.calls[1]![1].headers['if-none-match']).toBe('"v1"');
      expect(result).toMatchObject({ status: 'not-modified', fetchedAt: clock.now });
      expect(matcher.communityCount).toBe(LIST_SIZE);
      expect((await cache.getCommunity())?.fetchedAt).toBe(clock.now);
    });

    it('sends no ETag when no list is loaded, so a 304 can never leave it empty', async () => {
      const { refresher, matcher, cache, fetch } = setup();
      await refresher.refresh({ force: true });
      // Empty the served list and the shared snapshot; the store still remembers the old ETag.
      matcher.replaceCommunity([]);
      await cache.clear({ includeCustom: false });
      await refresher.refresh({ force: true });

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[1]![1].headers['if-none-match']).toBeUndefined();
    });

    it('refuses a 304 when the list was cleared meanwhile, and keeps the stored list', async () => {
      const fetch = vi
        .fn<FetchLike>()
        .mockResolvedValueOnce(okResponse())
        .mockImplementationOnce(() => {
          context.matcher.replaceCommunity([]);
          return Promise.resolve(makeResponse({ status: 304 }));
        });
      const context = setup({}, fetch);
      await context.refresher.refresh({ force: true });
      const result = await context.refresher.refresh({ force: true });

      expect(result.status).toBe('failed');
      expect(result.error).toBeInstanceOf(DatasetError);
      expect((await context.cache.getCommunity())?.domains).toHaveLength(LIST_SIZE);
    });
  });

  describe('failures keep the previous data', () => {
    it('on a network error', async () => {
      const fetch = vi
        .fn<FetchLike>()
        .mockResolvedValueOnce(okResponse())
        .mockRejectedValueOnce(new Error('offline'));
      const { refresher, matcher, errors } = setup({}, fetch);
      await refresher.refresh({ force: true });
      const result = await refresher.refresh({ force: true });

      expect(result.status).toBe('failed');
      expect(result.error).toBeInstanceOf(DatasetError);
      expect(errors).toEqual([result.error]);
      expect(matcher.communityCount).toBe(LIST_SIZE);
    });

    it('on an invalid dataset', async () => {
      const fetch = vi
        .fn<FetchLike>()
        .mockResolvedValueOnce(okResponse())
        .mockResolvedValueOnce(okResponse('<html>\n<body>Oops</body>\n</html>'));
      const { refresher, matcher, errors } = setup({}, fetch);
      await refresher.refresh({ force: true });
      const result = await refresher.refresh({ force: true });

      expect(result.status).toBe('failed');
      expect(errors[0]).toBeInstanceOf(DatasetError);
      expect(matcher.matches('mailinator.com')).toBe(true);
    });

    it('on a suspicious shrink', async () => {
      const fetch = vi
        .fn<FetchLike>()
        .mockResolvedValueOnce(okResponse(buildBlocklist([], 100)))
        .mockResolvedValueOnce(okResponse(buildBlocklist([], 20)));
      const { refresher, matcher, errors } = setup({}, fetch);
      await refresher.refresh({ force: true });
      const result = await refresher.refresh({ force: true });

      expect(result.status).toBe('failed');
      expect(errors[0]?.message).toMatch(/shrank from 100 to 20/);
      expect(matcher.communityCount).toBe(100);
    });

    it('reports a persist failure but still serves the new list', async () => {
      const { refresher, cache, matcher, errors } = setup();
      vi.spyOn(cache, 'setCommunity').mockRejectedValue(new CacheError('write failed'));
      const result = await refresher.refresh({ force: true });

      expect(result.status).toBe('updated');
      expect(errors).toEqual([expect.any(CacheError)]);
      expect(matcher.matches('mailinator.com')).toBe(true);
    });
  });

  describe('freshness (scheduled refreshes)', () => {
    it('skips the download while the shared snapshot is fresh', async () => {
      const { refresher, clock, fetch } = setup();
      await refresher.refresh({ force: true });
      clock.now += 999;
      const result = await refresher.refresh({ force: false });

      expect(result.status).toBe('synced');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('downloads once the snapshot is older than the freshness window', async () => {
      const { refresher, clock, fetch } = setup();
      await refresher.refresh({ force: true });
      clock.now += 1000;
      const result = await refresher.refresh({ force: false });

      expect(result.status).toBe('updated');
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('does not trust a snapshot dated in the future', async () => {
      const { refresher, cache, clock, fetch } = setup();
      await cache.setCommunity({ domains: ['future.test'], fetchedAt: clock.now + 60_000 });
      const result = await refresher.refresh({ force: false });

      expect(result.status).toBe('updated');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('always downloads when no freshness window is configured', async () => {
      const { refresher, fetch } = setup({ freshnessMs: undefined });
      await refresher.refresh({ force: true });
      await refresher.refresh({ force: false });

      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('ignores freshness for a manual refresh when a list is already loaded', async () => {
      const { refresher, fetch } = setup();
      await refresher.refresh({ force: true });
      await refresher.refresh({ force: true });

      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('adopts an existing shared snapshot instead of downloading when nothing is loaded', async () => {
      const { refresher, cache, matcher, fetch } = setup();
      await cache.setCommunity({ domains: ['shared.test'], fetchedAt: 1 });
      const result = await refresher.refresh({ force: true });

      expect(result.status).toBe('synced');
      expect(matcher.matches('shared.test')).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('concurrency', () => {
    it('shares one download between concurrent callers', async () => {
      const gate = createDeferred();
      const fetch = vi.fn<FetchLike>(async () => {
        await gate.promise;
        return okResponse();
      });
      const { refresher } = setup({}, fetch);
      const runs = [
        refresher.refresh({ force: true }),
        refresher.refresh({ force: false }),
        refresher.refresh({ force: true }),
      ];
      gate.resolve();
      const results = await Promise.all(runs);

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(results[1]).toBe(results[0]);
      expect(results[2]).toBe(results[0]);
    });

    it('allows a new refresh once the previous one finished', async () => {
      const { refresher, fetch } = setup();
      await refresher.refresh({ force: true });
      await refresher.refresh({ force: true });

      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('idle() resolves immediately when nothing runs, and after a running refresh otherwise', async () => {
      const gate = createDeferred();
      const fetch = vi.fn<FetchLike>(async () => {
        await gate.promise;
        return okResponse();
      });
      const { refresher, matcher } = setup({}, fetch);
      await expect(refresher.idle()).resolves.toBeUndefined();

      const running = refresher.refresh({ force: true });
      let idle = false;
      const waiting = refresher.idle().then(() => {
        idle = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(idle).toBe(false);

      gate.resolve();
      await Promise.all([running, waiting]);
      expect(idle).toBe(true);
      expect(matcher.communityCount).toBe(LIST_SIZE);
    });
  });

  describe('cross-instance lock', () => {
    it('requests the lock with the configured TTL and releases it after success', async () => {
      const { refresher, cache } = setup();
      const acquire = vi.spyOn(cache, 'acquireRefreshLock');
      await refresher.refresh({ force: true });

      expect(acquire).toHaveBeenCalledWith(5000);
      await expect(cache.acquireRefreshLock(1000)).resolves.not.toBeNull();
    });

    it('releases the lock after a failure', async () => {
      const fetch = vi.fn<FetchLike>(() => Promise.reject(new Error('offline')));
      const { refresher, cache } = setup({}, fetch);
      await refresher.refresh({ force: true });

      await expect(cache.acquireRefreshLock(1000)).resolves.not.toBeNull();
    });

    it('does not download while a peer holds the lock, and adopts what the peer stored', async () => {
      const { refresher, cache, matcher, fetch } = setup();
      const held = await cache.acquireRefreshLock(5000);
      await cache.setCommunity({ domains: ['peer-written.test'], fetchedAt: 1 });
      const result = await refresher.refresh({ force: true });

      expect(result.status).toBe('synced');
      expect(fetch).not.toHaveBeenCalled();
      expect(matcher.matches('peer-written.test')).toBe(true);
      await held!.release();
    });

    it('waits for the peer’s download to land when nothing is loaded', async () => {
      const peer = { act: (): Promise<void> => Promise.resolve() };
      const sleep = vi.fn(() => peer.act());
      const { refresher, cache, matcher, fetch } = setup({ sleep });
      peer.act = async () => {
        if (sleep.mock.calls.length === 2) {
          await cache.setCommunity({ domains: ['arrived.test'], fetchedAt: 1 });
        }
      };
      await cache.acquireRefreshLock(5000);
      const result = await refresher.refresh({ force: true });

      expect(sleep).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ status: 'synced', communityCount: 1 });
      expect(matcher.matches('arrived.test')).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('gives up waiting after peerWaitMs and leaves the instance empty', async () => {
      const sleep = vi.fn(() => Promise.resolve());
      const { refresher, cache } = setup({ sleep, peerWaitMs: 1000 });
      await cache.acquireRefreshLock(5000);
      const result = await refresher.refresh({ force: true });

      expect(sleep).toHaveBeenCalledTimes(4);
      expect(result).toMatchObject({ status: 'synced', communityCount: 0 });
    });

    it('does not wait when a list is already loaded', async () => {
      const sleep = vi.fn(() => Promise.resolve());
      const { refresher, cache } = setup({ sleep });
      await refresher.refresh({ force: true });
      await cache.acquireRefreshLock(5000);
      await refresher.refresh({ force: true });

      expect(sleep).not.toHaveBeenCalled();
    });

    it('reports a failure while following a peer', async () => {
      const { refresher, cache, errors } = setup();
      await cache.acquireRefreshLock(5000);
      vi.spyOn(cache, 'getVersion').mockRejectedValue(new CacheError('down'));
      const result = await refresher.refresh({ force: true });

      expect(result.status).toBe('failed');
      expect(errors).toEqual([expect.any(CacheError)]);
    });

    it('still refreshes this instance when the lock backend is unavailable', async () => {
      const { refresher, cache, errors, matcher } = setup();
      vi.spyOn(cache, 'acquireRefreshLock').mockRejectedValue(new CacheError('redis down'));
      const result = await refresher.refresh({ force: false });

      expect(result.status).toBe('updated');
      expect(errors).toEqual([expect.any(CacheError)]);
      expect(matcher.matches('mailinator.com')).toBe(true);
    });

    it('skips the shared cache quietly while the backend is unhealthy', async () => {
      const { refresher, cache, matcher, errors, fetch } = setup();
      vi.spyOn(cache, 'isHealthy').mockReturnValue(false);
      const acquire = vi.spyOn(cache, 'acquireRefreshLock');
      const getCommunity = vi.spyOn(cache, 'getCommunity');
      const result = await refresher.refresh({ force: false });

      expect(result.status).toBe('updated');
      expect(acquire).not.toHaveBeenCalled();
      expect(getCommunity).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(matcher.matches('mailinator.com')).toBe(true);
    });
  });
});
