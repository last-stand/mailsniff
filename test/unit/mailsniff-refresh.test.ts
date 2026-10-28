import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCache } from '../../src/cache/memory-cache';
import type { FetchLike } from '../../src/dataset/fetcher';
import { CacheError, ClosedError, DatasetError } from '../../src/errors';
import { MailSniff } from '../../src/mailsniff';
import type { MailSniffOptions } from '../../src/types';
import { createDeferred, flushPromises } from '../helpers/deferred';
import { makeResponse } from '../helpers/fake-fetch';
import { buildBlocklist, SAMPLE_DOMAINS } from '../helpers/fixtures';

const HOUR = 3_600_000;

function listResponse(extra: string[] = []) {
  return makeResponse({
    body: buildBlocklist([...SAMPLE_DOMAINS, ...extra]),
    headers: { etag: '"v1"' },
  });
}

const opened: MailSniff[] = [];

function create(
  overrides: Partial<MailSniffOptions> = {},
  fetch = vi.fn<FetchLike>(() => Promise.resolve(listResponse())),
  cache = new MemoryCache(),
) {
  const errors: Error[] = [];
  const sniff = new MailSniff({
    cache,
    dataset: { fetch, minDomains: 10 },
    onError: (error) => errors.push(error),
    ...overrides,
  });
  opened.push(sniff);
  return { sniff, fetch, cache, errors };
}

beforeEach(() => {
  // 0.5 makes the ±10% jitter exactly zero, so timings are deterministic.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((sniff) => sniff.close()));
  vi.useRealTimers();
});

describe('automatic refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('is disabled when no refreshInterval is set', async () => {
    const { sniff } = create();
    await sniff.init();

    expect(vi.getTimerCount()).toBe(0);
    expect(sniff.status()).toMatchObject({ autoRefresh: false, nextRefreshAt: null });
  });

  it('refreshes at the configured interval and serves the new list', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockImplementationOnce(() => Promise.resolve(listResponse()))
      .mockImplementation(() => Promise.resolve(listResponse(['added-later.test'])));
    const { sniff } = create({ refreshInterval: '1h' }, fetch);
    await sniff.init();

    expect(vi.getTimerCount()).toBe(1);
    expect(sniff.status()).toMatchObject({ autoRefresh: true, nextRefreshAt: Date.now() + HOUR });
    expect(await sniff.isDisposableDomain('added-later.test')).toBe(false);

    await vi.advanceTimersByTimeAsync(HOUR);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await sniff.isDisposableDomain('added-later.test')).toBe(true);

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('keeps detecting when a refresh fails, then retries with backoff', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockImplementationOnce(() => Promise.resolve(listResponse()))
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(() => Promise.resolve(listResponse(['recovered.test'])));
    const { sniff, errors } = create({ refreshInterval: '1h' }, fetch);
    await sniff.init();
    await vi.advanceTimersByTimeAsync(HOUR);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await sniff.isDisposableDomain('mailinator.com')).toBe(true);
    expect(errors[0]).toBeInstanceOf(DatasetError);
    expect(sniff.status().lastError).toBe(errors[0]);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(await sniff.isDisposableDomain('recovered.test')).toBe(true);
  });

  it('refreshes right after startup when the cached list is already stale', async () => {
    const cache = new MemoryCache();
    await cache.setCommunity({ domains: ['stale-entry.test'], fetchedAt: Date.now() - 2 * HOUR });
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(listResponse(['fresh-entry.test'])));
    const { sniff } = create({ refreshInterval: '1h' }, fetch, cache);
    await sniff.init();

    expect(fetch).not.toHaveBeenCalled();
    expect(await sniff.isDisposableDomain('stale-entry.test')).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(async () => {
      expect(await sniff.isDisposableDomain('fresh-entry.test')).toBe(true);
    });
  });

  it('retries soon when the first download failed', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(() => Promise.resolve(listResponse()));
    const { sniff } = create({ refreshInterval: '1h' }, fetch);
    await sniff.init();

    expect(sniff.status().state).toBe('degraded');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sniff.status().state).toBe('ready');
    expect(await sniff.isDisposableDomain('mailinator.com')).toBe(true);
  });

  it('never refreshes a custom domain away', async () => {
    const { sniff } = create({ refreshInterval: '1h' });
    await sniff.addDisposableDomains(['mine.test']);
    await vi.advanceTimersByTimeAsync(HOUR);

    expect(await sniff.isDisposableDomain('mine.test')).toBe(true);
  });
});

describe('manual refresh', () => {
  it('downloads again and reports the outcome', async () => {
    const { sniff, fetch } = create();
    await sniff.init();
    const result = await sniff.refresh();

    expect(result.status).toBe('updated');
    expect(result.communityCount).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('initializes the instance when called first, with a single download', async () => {
    const { sniff, fetch } = create();
    const result = await sniff.refresh();

    expect(result.status).toBe('updated');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries when the download made during initialization failed', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(() => Promise.resolve(listResponse()));
    const { sniff } = create({}, fetch);
    const result = await sniff.refresh();

    expect(result.status).toBe('updated');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('resolves with status failed instead of throwing, and keeps serving', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockImplementationOnce(() => Promise.resolve(listResponse()))
      .mockRejectedValueOnce(new Error('offline'));
    const { sniff, errors } = create({}, fetch);
    await sniff.init();
    const result = await sniff.refresh();

    expect(result.status).toBe('failed');
    expect(result.error).toBeInstanceOf(DatasetError);
    expect(errors).toEqual([result.error]);
    expect(await sniff.isDisposableDomain('mailinator.com')).toBe(true);
  });

  it('shares one download between concurrent calls', async () => {
    const { sniff, fetch } = create();
    await sniff.init();
    await Promise.all([sniff.refresh(), sniff.refresh(), sniff.refresh()]);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects with ClosedError after close()', async () => {
    const { sniff } = create();
    await sniff.close();

    await expect(sniff.refresh()).rejects.toBeInstanceOf(ClosedError);
  });
});

describe('cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('close() cancels the schedule', async () => {
    const { sniff, fetch } = create({ refreshInterval: '1h' });
    await sniff.init();
    await sniff.close();

    expect(vi.getTimerCount()).toBe(0);
    expect(sniff.status()).toMatchObject({ state: 'closed', nextRefreshAt: null });

    await vi.advanceTimersByTimeAsync(5 * HOUR);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('close() waits for a refresh in progress before closing the cache', async () => {
    const gate = createDeferred();
    const fetch = vi
      .fn<FetchLike>()
      .mockImplementationOnce(() => Promise.resolve(listResponse()))
      .mockImplementation(async () => {
        await gate.promise;
        return listResponse();
      });
    const { sniff, cache } = create({ refreshInterval: '1h' }, fetch);
    await sniff.init();
    await vi.advanceTimersByTimeAsync(HOUR);
    const closeSpy = vi.spyOn(cache, 'close');

    let closed = false;
    const closing = sniff.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(closed).toBe(false);
    expect(closeSpy).not.toHaveBeenCalled();

    gate.resolve();
    await closing;

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start the schedule when closed during initialization', async () => {
    const gate = createDeferred();
    const fetch = vi.fn<FetchLike>(async () => {
      await gate.promise;
      return listResponse();
    });
    const { sniff } = create({ refreshInterval: '1h' }, fetch);
    const initializing = sniff.init();
    const closing = sniff.close();
    gate.resolve();
    await Promise.all([initializing, closing]);

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('synchronization between instances sharing a backend', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  it('picks up custom domains added elsewhere, within the check interval', async () => {
    const cache = new MemoryCache();
    const a = create({}, undefined, cache).sniff;
    const b = create({}, undefined, cache).sniff;
    await a.init();
    await b.init();
    await a.addDisposableDomains(['from-a.test']);

    expect(await b.isDisposableDomain('from-a.test')).toBe(false);

    vi.setSystemTime(Date.now() + 31_000);
    await b.isDisposableDomain('anything.test'); // starts the background check
    await flushPromises();

    expect(await b.isDisposableDomain('from-a.test')).toBe(true);
  });

  it('adopts a community list refreshed by another instance', async () => {
    const cache = new MemoryCache();
    const fetchA = vi
      .fn<FetchLike>()
      .mockImplementationOnce(() => Promise.resolve(listResponse()))
      .mockImplementation(() => Promise.resolve(listResponse(['peer-new.test'])));
    const a = create({}, fetchA, cache).sniff;
    const b = create({}, undefined, cache);
    await a.init();
    await b.sniff.init();
    await a.refresh();

    vi.setSystemTime(Date.now() + 31_000);
    await b.sniff.isDisposableDomain('anything.test');
    await flushPromises();

    expect(await b.sniff.isDisposableDomain('peer-new.test')).toBe(true);
    expect(b.fetch).toHaveBeenCalledTimes(0);
  });

  it('checks the backend at most once per interval, however many lookups happen', async () => {
    const { sniff, cache } = create();
    await sniff.init();
    const getVersion = vi.spyOn(cache, 'getVersion');

    await Promise.all(Array.from({ length: 20 }, () => sniff.isDisposableDomain('a.test')));
    expect(getVersion).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 31_000);
    await Promise.all(Array.from({ length: 20 }, () => sniff.isDisposableDomain('a.test')));
    await flushPromises();

    expect(getVersion).toHaveBeenCalledTimes(1);
  });

  it('reports a failing check without failing the lookup', async () => {
    const { sniff, cache, errors } = create();
    await sniff.init();
    vi.spyOn(cache, 'getVersion').mockRejectedValue(new CacheError('redis down'));
    vi.setSystemTime(Date.now() + 31_000);

    expect(await sniff.isDisposableDomain('mailinator.com')).toBe(true);
    await flushPromises();

    expect(errors).toEqual([expect.any(CacheError)]);
  });

  it('recovers after the backend comes back', async () => {
    const cache = new MemoryCache();
    const connect = vi.spyOn(cache, 'connect').mockRejectedValueOnce(new CacheError('down'));
    const other = create({}, undefined, new MemoryCache()).sniff;
    await other.init();

    const { sniff } = create({}, undefined, cache);
    await cache.addCustomDomains(['stored-before.test']);
    await sniff.init(); // connect fails once: the stored custom domain is not loaded

    expect(connect).toHaveBeenCalledTimes(1);
    expect(await sniff.isDisposableDomain('stored-before.test')).toBe(false);

    vi.setSystemTime(Date.now() + 31_000);
    await sniff.isDisposableDomain('anything.test');
    await flushPromises();

    expect(await sniff.isDisposableDomain('stored-before.test')).toBe(true);
  });
});
