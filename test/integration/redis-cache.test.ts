import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RedisCache } from '../../src/cache/redis-cache';
import type { FetchLike } from '../../src/dataset/fetcher';
import { MailSniff } from '../../src/mailsniff';
import { makeResponse } from '../helpers/fake-fetch';
import { buildBlocklist } from '../helpers/fixtures';

const REDIS_URL = process.env['REDIS_URL'];

console.log(REDIS_URL);

// Runs against a real Redis (CI provides one). Skipped locally unless REDIS_URL is set.
describe.skipIf(!REDIS_URL)('Redis backend (real Redis)', () => {
  const keyPrefix = `mailsniff-test:${randomUUID()}`;
  let cache: RedisCache;

  beforeAll(async () => {
    cache = new RedisCache({ url: REDIS_URL, keyPrefix });
    await cache.connect();
  });

  afterAll(async () => {
    await cache.clear({ includeCustom: true });
    await cache.close();
  });

  it('connects and reports healthy', () => {
    expect(cache.isHealthy()).toBe(true);
  });

  it('round-trips a large community snapshot atomically', async () => {
    const domains = Array.from({ length: 5000 }, (_unused, index) => `d${index}.integration.test`);
    await cache.setCommunity({ domains, etag: '"etag"', fetchedAt: 123 });

    await expect(cache.getCommunity()).resolves.toEqual({
      domains,
      etag: '"etag"',
      fetchedAt: 123,
    });
  });

  it('manages custom domains and bumps the version', async () => {
    const before = await cache.getVersion();
    await cache.addCustomDomains(['a.integration.test', 'b.integration.test']);
    await cache.removeCustomDomains(['a.integration.test']);

    await expect(cache.getCustomDomains()).resolves.toEqual(['b.integration.test']);
    expect(await cache.getVersion()).not.toBe(before);
  });

  it('enforces the refresh lock across holders', async () => {
    const other = new RedisCache({ url: REDIS_URL, keyPrefix });
    await other.connect();

    const lock = await cache.acquireRefreshLock(10_000);
    expect(lock).not.toBeNull();
    await expect(other.acquireRefreshLock(10_000)).resolves.toBeNull();

    await lock!.release();

    const next = await other.acquireRefreshLock(10_000);
    expect(next).not.toBeNull();
    await next!.release();
    await other.close();
  });

  it('shares data between MailSniff instances and closes the client it created', async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(makeResponse({ body: buildBlocklist() })));
    const options = {
      redis: { url: REDIS_URL, keyPrefix: `${keyPrefix}:e2e` },
      dataset: { fetch, minDomains: 10 },
    };
    const first = new MailSniff(options);
    await first.addDisposableDomains(['shared.integration.test']);

    const second = new MailSniff(options);
    expect(await second.isDisposableDomain('mailinator.com')).toBe(true);
    expect(await second.isDisposableDomain('shared.integration.test')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);

    await first.clearCache({ includeCustom: true });
    await first.close();
    await second.close();
  });
});
