import { describe, expect, it, vi } from 'vitest';
import { MemoryCache } from '../../src/cache/memory-cache';
import type { FetchLike } from '../../src/dataset/fetcher';
import {
  CacheError,
  ClosedError,
  ConfigError,
  DatasetError,
  ValidationError,
} from '../../src/errors';
import { MailSniff } from '../../src/mailsniff';
import type { MailSniffOptions } from '../../src/types';
import { makeResponse } from '../helpers/fake-fetch';
import { FakeRedis } from '../helpers/fake-redis';
import { buildBlocklist, FILLER_COUNT, SAMPLE_DOMAINS } from '../helpers/fixtures';

function createFetch(body = buildBlocklist()) {
  return vi.fn<FetchLike>(() => Promise.resolve(makeResponse({ body, headers: { etag: '"v1"' } })));
}

function create(
  overrides: Partial<MailSniffOptions> = {},
  fetch = createFetch(),
  cache = new MemoryCache(),
) {
  const errors: Error[] = [];
  const sniff = new MailSniff({
    cache,
    dataset: { fetch, minDomains: 10 },
    onError: (error) => errors.push(error),
    ...overrides,
  });
  return { sniff, fetch, cache, errors };
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('MailSniff', () => {
  describe('domain detection', () => {
    it('detects community domains and ignores others', async () => {
      const { sniff } = create();

      expect(await sniff.isDisposableDomain('mailinator.com')).toBe(true);
      expect(await sniff.isDisposableDomain('gmail.com')).toBe(false);
    });

    it('normalizes the input', async () => {
      const { sniff } = create();

      expect(await sniff.isDisposableDomain('  MAILINATOR.com. '.replace('INATOR', 'inator'))).toBe(
        true,
      );
      expect(await sniff.isDisposableDomain('Guerrillamail.COM')).toBe(true);
    });

    it('matches subdomains by default and can be switched off', async () => {
      const on = create();
      const off = create({ matchSubdomains: false });

      expect(await on.sniff.isDisposableDomain('x.mailinator.com')).toBe(true);
      expect(await off.sniff.isDisposableDomain('x.mailinator.com')).toBe(false);
    });

    it.each(['', 'not a domain', 'localhost', 'a@b.com', 'http://mailinator.com'])(
      'returns false for the invalid domain %j',
      async (input) => {
        const { sniff } = create();

        expect(await sniff.isDisposableDomain(input)).toBe(false);
      },
    );

    it('throws a TypeError for non-string input', async () => {
      const { sniff } = create();

      await expect(sniff.isDisposableDomain(42 as unknown as string)).rejects.toThrow(TypeError);
      await expect(sniff.isDisposableDomain(undefined as unknown as string)).rejects.toThrow(
        TypeError,
      );
    });
  });

  describe('email detection', () => {
    it('detects disposable addresses case-insensitively', async () => {
      const { sniff } = create();

      expect(await sniff.isDisposableEmail('user@mailinator.com')).toBe(true);
      expect(await sniff.isDisposableEmail(' User+tag@MAILINATOR.com ')).toBe(true);
      expect(await sniff.isDisposableEmail('user@sub.mailinator.com')).toBe(true);
    });

    it('does not flag regular providers', async () => {
      const { sniff } = create();

      expect(await sniff.isDisposableEmail('user@gmail.com')).toBe(false);
    });

    it.each(['', 'plain', '@mailinator.com', 'user@', 'us er@mailinator.com', 'user@localhost'])(
      'returns false for the malformed address %j',
      async (input) => {
        const { sniff } = create();

        expect(await sniff.isDisposableEmail(input)).toBe(false);
      },
    );

    it('throws a TypeError for non-string input', async () => {
      const { sniff } = create();

      await expect(sniff.isDisposableEmail(null as unknown as string)).rejects.toThrow(TypeError);
    });
  });

  describe('initialization', () => {
    it('is lazy: nothing is fetched until the first use', () => {
      const { sniff, fetch } = create();

      expect(fetch).not.toHaveBeenCalled();
      expect(sniff.status().state).toBe('uninitialized');
    });

    it('downloads once for concurrent first lookups, and never again', async () => {
      const { sniff, fetch } = create();

      await Promise.all(
        Array.from({ length: 10 }, () => sniff.isDisposableDomain('mailinator.com')),
      );
      await sniff.isDisposableDomain('mailinator.com');
      await sniff.init();

      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('passes the configured source URL to the fetcher', async () => {
      const { sniff, fetch } = create({
        dataset: {
          sourceUrl: 'https://mirror.test/list.conf',
          fetch: createFetch(),
          minDomains: 10,
        },
      });
      await sniff.init();

      expect(fetch).not.toHaveBeenCalled();
    });

    it('stores the downloaded dataset in the cache', async () => {
      const { sniff, cache } = create();
      await sniff.init();

      const stored = await cache.getCommunity();
      expect(stored?.domains).toContain('mailinator.com');
      expect(stored?.etag).toBe('"v1"');
      expect(typeof stored?.fetchedAt).toBe('number');
    });

    it('loads an existing snapshot and custom domains from the cache without downloading', async () => {
      const cache = new MemoryCache();
      await cache.setCommunity({ domains: ['cached-disposable.test'], fetchedAt: 1000 });
      await cache.addCustomDomains(['custom-stored.test']);
      const { sniff, fetch } = create({}, createFetch(), cache);

      expect(await sniff.isDisposableDomain('cached-disposable.test')).toBe(true);
      expect(await sniff.isDisposableDomain('custom-stored.test')).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
      expect(sniff.status().communityFetchedAt).toBe(1000);
    });
  });

  describe('when the dataset cannot be loaded', () => {
    it('starts degraded, reports the error and keeps answering', async () => {
      const fetch = vi.fn<FetchLike>(() => Promise.reject(new Error('offline')));
      const { sniff, errors } = create({}, fetch);

      await expect(sniff.init()).resolves.toBeUndefined();

      expect(await sniff.isDisposableDomain('mailinator.com')).toBe(false);
      const status = sniff.status();
      expect(status.state).toBe('degraded');
      expect(status.communityCount).toBe(0);
      expect(errors[0]).toBeInstanceOf(DatasetError);
      expect(status.lastError).toBe(errors[0]);
    });

    it('still supports custom domains while degraded', async () => {
      const fetch = vi.fn<FetchLike>(() => Promise.reject(new Error('offline')));
      const { sniff } = create({}, fetch);
      await sniff.addDisposableDomains(['mine.test']);

      expect(await sniff.isDisposableDomain('mine.test')).toBe(true);
    });

    it('rejects an invalid dataset instead of using it', async () => {
      const { sniff, errors } = create({}, createFetch('<html>\n<body>Not found</body>\n</html>'));
      await sniff.init();

      expect(sniff.status().communityCount).toBe(0);
      expect(errors[0]).toBeInstanceOf(DatasetError);
    });

    it('rejects init() with failOnInitError and allows a retry', async () => {
      const fetch = vi
        .fn<FetchLike>()
        .mockRejectedValueOnce(new Error('offline'))
        .mockImplementation(() => Promise.resolve(makeResponse({ body: buildBlocklist() })));
      const { sniff } = create({ failOnInitError: true }, fetch);

      await expect(sniff.init()).rejects.toBeInstanceOf(DatasetError);
      await expect(sniff.init()).resolves.toBeUndefined();

      expect(await sniff.isDisposableDomain('mailinator.com')).toBe(true);
    });

    it('survives an onError callback that throws', async () => {
      const fetch = vi.fn<FetchLike>(() => Promise.reject(new Error('offline')));
      const { sniff } = create(
        {
          onError: () => {
            throw new Error('callback failure');
          },
        },
        fetch,
      );

      await expect(sniff.init()).resolves.toBeUndefined();
      expect(sniff.status().lastError).toBeInstanceOf(DatasetError);
    });
  });

  describe('when the cache backend misbehaves', () => {
    it('falls back to downloading when the backend cannot connect', async () => {
      const cache = new MemoryCache();
      vi.spyOn(cache, 'connect').mockRejectedValue(new CacheError('unreachable'));
      vi.spyOn(cache, 'isHealthy').mockReturnValue(false);
      const getCommunity = vi.spyOn(cache, 'getCommunity');
      const { sniff, errors } = create({}, createFetch(), cache);

      expect(await sniff.isDisposableDomain('mailinator.com')).toBe(true);

      expect(getCommunity).not.toHaveBeenCalled();
      expect(errors).toEqual([expect.any(CacheError)]);
      expect(sniff.status().state).toBe('degraded');
    });

    it('rejects init() when the backend cannot connect and failOnInitError is set', async () => {
      const cache = new MemoryCache();
      vi.spyOn(cache, 'connect').mockRejectedValue(new CacheError('unreachable'));
      const { sniff } = create({ failOnInitError: true }, createFetch(), cache);

      await expect(sniff.init()).rejects.toBeInstanceOf(CacheError);
    });

    it('always rejects init() for configuration errors', async () => {
      const cache = new MemoryCache();
      vi.spyOn(cache, 'connect').mockRejectedValue(new ConfigError('ioredis is not installed'));
      const { sniff, errors } = create({}, createFetch(), cache);

      await expect(sniff.init()).rejects.toBeInstanceOf(ConfigError);
      expect(errors).toEqual([]);
    });

    it('serves a downloaded dataset even when persisting it fails', async () => {
      const cache = new MemoryCache();
      vi.spyOn(cache, 'setCommunity').mockRejectedValue(new CacheError('write failed'));
      const { sniff, errors } = create({}, createFetch(), cache);

      expect(await sniff.isDisposableDomain('mailinator.com')).toBe(true);
      expect(errors).toEqual([expect.any(CacheError)]);
    });
  });

  describe('custom domains', () => {
    it('normalizes, de-duplicates and persists to the cache', async () => {
      const { sniff, cache } = create();
      await sniff.addDisposableDomains([' Custom.EXAMPLE ', 'custom.example', 'other.test']);

      expect(await sniff.isDisposableDomain('custom.example')).toBe(true);
      expect(await sniff.isDisposableEmail('me@other.test')).toBe(true);
      expect((await cache.getCustomDomains()).sort()).toEqual(['custom.example', 'other.test']);
    });

    it('accepts a single string', async () => {
      const { sniff } = create();
      await sniff.addDisposableDomains('single.test');

      expect(await sniff.isDisposableDomain('single.test')).toBe(true);
    });

    it('treats an empty list as a no-op', async () => {
      const { sniff, cache } = create();
      const add = vi.spyOn(cache, 'addCustomDomains');
      await sniff.addDisposableDomains([]);

      expect(add).not.toHaveBeenCalled();
    });

    it('is all-or-nothing for invalid input', async () => {
      const { sniff } = create();

      await expect(sniff.addDisposableDomains(['ok.test', 'not a domain'])).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(await sniff.isDisposableDomain('ok.test')).toBe(false);
    });

    it('rejects input that is neither a string nor an array', async () => {
      const { sniff } = create();

      await expect(sniff.addDisposableDomains(42 as unknown as string)).rejects.toThrow(TypeError);
    });

    it('does not change local state when the backend rejects the write', async () => {
      const { sniff, cache } = create();
      vi.spyOn(cache, 'addCustomDomains').mockRejectedValue(new CacheError('redis down'));

      await expect(sniff.addDisposableDomains(['x.test'])).rejects.toBeInstanceOf(CacheError);
      expect(await sniff.isDisposableDomain('x.test')).toBe(false);
    });

    it('merges with the community list without duplicates', async () => {
      const { sniff } = create();
      await sniff.addDisposableDomains(['zzz.test', 'mailinator.com']);
      const list = await sniff.listDisposableDomains();

      expect(list).toContain('zzz.test');
      expect(list.filter((domain) => domain === 'mailinator.com')).toHaveLength(1);
      expect(list).toEqual([...list].sort());
      expect(list).toHaveLength(SAMPLE_DOMAINS.length + FILLER_COUNT + 1);
    });

    it('removes only custom domains and ignores unknown ones', async () => {
      const { sniff, cache } = create();
      await sniff.addDisposableDomains(['a.test', 'b.test']);
      await sniff.removeDisposableDomains(['a.test', 'unknown.test', 'mailinator.com']);

      expect(await sniff.isDisposableDomain('a.test')).toBe(false);
      expect(await sniff.isDisposableDomain('b.test')).toBe(true);
      expect(await sniff.isDisposableDomain('mailinator.com')).toBe(true);
      expect(await cache.getCustomDomains()).toEqual(['b.test']);
    });

    it('validates input when removing', async () => {
      const { sniff } = create();

      await expect(sniff.removeDisposableDomains(['not a domain'])).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(sniff.removeDisposableDomains([])).resolves.toBeUndefined();
    });

    it('is not overwritten by loading the community list', async () => {
      const { sniff } = create();
      await sniff.addDisposableDomains(['mine.test']);
      await sniff.clearCache();

      expect(await sniff.isDisposableDomain('mine.test')).toBe(true);
    });
  });

  describe('clearCache', () => {
    it('keeps custom domains by default and reloads the community list', async () => {
      const { sniff, fetch, cache } = create();
      await sniff.addDisposableDomains(['mine.test']);
      await sniff.clearCache();

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(await sniff.isDisposableDomain('mailinator.com')).toBe(true);
      expect(await sniff.isDisposableDomain('mine.test')).toBe(true);
      expect(await cache.getCustomDomains()).toEqual(['mine.test']);
    });

    it('removes custom domains with includeCustom', async () => {
      const { sniff, cache } = create();
      await sniff.addDisposableDomains(['mine.test']);
      await sniff.clearCache({ includeCustom: true });

      expect(await sniff.isDisposableDomain('mine.test')).toBe(false);
      expect(await cache.getCustomDomains()).toEqual([]);
    });

    it('reports a failed reload and leaves the community list empty', async () => {
      const { sniff, fetch, errors } = create();
      await sniff.init();
      fetch.mockImplementation(() => Promise.reject(new Error('offline')));
      await sniff.clearCache();

      expect(errors[0]).toBeInstanceOf(DatasetError);
      expect(sniff.status().communityCount).toBe(0);
      expect(await sniff.isDisposableDomain('mailinator.com')).toBe(false);
    });

    it('propagates backend failures and leaves local data untouched', async () => {
      const { sniff, cache } = create();
      await sniff.init();
      vi.spyOn(cache, 'clear').mockRejectedValue(new CacheError('redis down'));

      await expect(sniff.clearCache()).rejects.toBeInstanceOf(CacheError);
      expect(await sniff.isDisposableDomain('mailinator.com')).toBe(true);
    });
  });

  describe('status', () => {
    it('describes a ready instance', async () => {
      const { sniff } = create();
      await sniff.addDisposableDomains(['mine.test']);
      const status = sniff.status();

      expect(status).toMatchObject({
        state: 'ready',
        backend: 'memory',
        cacheHealthy: true,
        communityCount: SAMPLE_DOMAINS.length + FILLER_COUNT,
        customCount: 1,
        lastError: null,
      });
      expect(typeof status.communityFetchedAt).toBe('number');
    });

    it('reports initializing while the first download is in flight', async () => {
      const gate = createDeferred();
      const fetch = vi.fn<FetchLike>(async () => {
        await gate.promise;
        return makeResponse({ body: buildBlocklist() });
      });
      const { sniff } = create({}, fetch);
      const pending = sniff.init();

      expect(sniff.status().state).toBe('initializing');

      gate.resolve();
      await pending;
      expect(sniff.status().state).toBe('ready');
    });
  });

  describe('close', () => {
    it('closes the cache once, even when called repeatedly', async () => {
      const { sniff, cache } = create();
      const close = vi.spyOn(cache, 'close');
      await sniff.init();
      await sniff.close();
      await sniff.close();

      expect(close).toHaveBeenCalledTimes(1);
      expect(sniff.status().state).toBe('closed');
    });

    it('rejects every later call with ClosedError', async () => {
      const { sniff } = create();
      await sniff.close();

      await expect(sniff.init()).rejects.toBeInstanceOf(ClosedError);
      await expect(sniff.isDisposableDomain('mailinator.com')).rejects.toBeInstanceOf(ClosedError);
      await expect(sniff.isDisposableEmail('a@mailinator.com')).rejects.toBeInstanceOf(ClosedError);
      await expect(sniff.listDisposableDomains()).rejects.toBeInstanceOf(ClosedError);
      await expect(sniff.addDisposableDomains(['a.test'])).rejects.toBeInstanceOf(ClosedError);
      await expect(sniff.clearCache()).rejects.toBeInstanceOf(ClosedError);
    });

    it('waits for an in-flight initialization before closing the cache', async () => {
      const gate = createDeferred();
      const fetch = vi.fn<FetchLike>(async () => {
        await gate.promise;
        return makeResponse({ body: buildBlocklist() });
      });
      const { sniff, cache } = create({}, fetch);
      const closeSpy = vi.spyOn(cache, 'close');
      const initPromise = sniff.init();
      const closePromise = sniff.close();

      await Promise.resolve();
      expect(closeSpy).not.toHaveBeenCalled();

      gate.resolve();
      await closePromise;
      await initPromise;

      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('reports a failing cache.close() instead of throwing', async () => {
      const { sniff, cache, errors } = create();
      vi.spyOn(cache, 'close').mockRejectedValue(new CacheError('close failed'));

      await expect(sniff.close()).resolves.toBeUndefined();
      expect(errors).toEqual([expect.any(CacheError)]);
    });
  });

  describe('redis backend', () => {
    function createRedisSniff(redis: FakeRedis, fetch: ReturnType<typeof createFetch>) {
      const errors: Error[] = [];
      const sniff = new MailSniff({
        redis: { client: redis, keyPrefix: 'ms' },
        dataset: { fetch, minDomains: 10 },
        onError: (error) => errors.push(error),
      });
      return { sniff, errors };
    }

    it('stores data in Redis and shares it with a second instance', async () => {
      const redis = new FakeRedis();
      const first = createRedisSniff(redis, createFetch()).sniff;
      await first.addDisposableDomains(['shared-custom.test']);

      expect(redis.hashes.has('ms:community')).toBe(true);
      expect(first.status()).toMatchObject({
        backend: 'redis',
        cacheHealthy: true,
        state: 'ready',
      });

      const secondFetch = createFetch();
      const second = createRedisSniff(redis, secondFetch).sniff;

      expect(await second.isDisposableDomain('mailinator.com')).toBe(true);
      expect(await second.isDisposableDomain('shared-custom.test')).toBe(true);
      expect(secondFetch).not.toHaveBeenCalled();

      await first.close();
      await second.close();
      expect(redis.quitCalls).toBe(0);
    });

    it('keeps answering when Redis is unreachable, but refuses custom domain writes', async () => {
      const redis = new FakeRedis();
      redis.failWith = new Error('ECONNREFUSED');
      redis.status = 'end';
      const { sniff, errors } = createRedisSniff(redis, createFetch());

      await sniff.init();

      expect(await sniff.isDisposableDomain('mailinator.com')).toBe(true);
      expect(sniff.status()).toMatchObject({
        state: 'degraded',
        cacheHealthy: false,
        backend: 'redis',
      });
      await expect(sniff.addDisposableDomains(['x.test'])).rejects.toBeInstanceOf(CacheError);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every((error) => error instanceof CacheError)).toBe(true);
    });
  });

  it('fails fast and synchronously on invalid options', () => {
    expect(() => new MailSniff({ matchSubdomains: 'yes' as unknown as boolean })).toThrow(
      ConfigError,
    );
    expect(() => new MailSniff({ redis: { url: 'http://localhost' } })).toThrow(ConfigError);
  });
});
