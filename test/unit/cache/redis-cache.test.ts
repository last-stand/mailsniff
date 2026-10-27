import { afterEach, describe, expect, it, vi } from 'vitest';
import { RedisCache } from '../../../src/cache/redis-cache';
import type { RedisCacheOptions } from '../../../src/cache/redis-cache';
import { CacheError, ConfigError } from '../../../src/errors';
import { FakeRedis } from '../../helpers/fake-redis';

const snapshot = { domains: ['a.com', 'b.com'], etag: '"v1"', fetchedAt: 1000 };

async function connected(
  overrides: Partial<RedisCacheOptions> = {},
): Promise<{ cache: RedisCache; redis: FakeRedis }> {
  const redis = new FakeRedis();
  const cache = new RedisCache({ client: redis, keyPrefix: 'test', ...overrides });
  await cache.connect();
  return { cache, redis };
}

describe('RedisCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('construction and connection', () => {
    it('requires a url or a client', () => {
      expect(() => new RedisCache({})).toThrow(ConfigError);
    });

    it('is not healthy and refuses operations before connect() when it creates its own client', async () => {
      const cache = new RedisCache({
        url: 'redis://localhost',
        createClient: () => Promise.resolve(new FakeRedis()),
      });

      expect(cache.isHealthy()).toBe(false);
      await expect(cache.getCommunity()).rejects.toThrow(CacheError);
      await expect(cache.getCommunity()).rejects.toThrow(/not connected/);
    });

    it('uses a client passed in by the caller immediately, without connect()', async () => {
      const cache = new RedisCache({ client: new FakeRedis() });

      expect(cache.isHealthy()).toBe(true);
      await expect(cache.getCommunity()).resolves.toBeNull();
    });

    it('pings on connect and reports health from the client status', async () => {
      const { cache, redis } = await connected();

      expect(cache.isHealthy()).toBe(true);
      redis.status = 'reconnecting';
      expect(cache.isHealthy()).toBe(false);
    });

    it('starts a lazy client that is waiting', async () => {
      const redis = new FakeRedis();
      redis.status = 'wait';
      await new RedisCache({ client: redis }).connect();

      expect(redis.connectCalls).toBe(1);
    });

    it('wraps a failed ping in a CacheError', async () => {
      const redis = new FakeRedis();
      redis.failWith = new Error('ECONNREFUSED');

      const cache = new RedisCache({ client: redis });

      await expect(cache.connect()).rejects.toThrow(CacheError);
      await expect(cache.connect()).rejects.toThrow(/ECONNREFUSED/);
    });

    it('times out when Redis never answers', async () => {
      vi.useFakeTimers();
      const redis = new FakeRedis();
      redis.hangPing = true;
      const cache = new RedisCache({ client: redis, connectTimeoutMs: 50 });

      const assertion = expect(cache.connect()).rejects.toThrow(/no reply within 50ms/);
      await vi.advanceTimersByTimeAsync(50);

      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    });

    it('refuses to connect after close()', async () => {
      const { cache } = await connected();
      await cache.close();

      await expect(cache.connect()).rejects.toThrow(CacheError);
    });

    it('creates the client from the url and propagates ConfigError unchanged', async () => {
      const createClient = vi.fn(() => Promise.reject(new ConfigError('ioredis is not installed')));
      const cache = new RedisCache({ url: 'redis://localhost', createClient });

      await expect(cache.connect()).rejects.toBeInstanceOf(ConfigError);
      expect(createClient).toHaveBeenCalledWith('redis://localhost');
    });
  });

  describe('community snapshot', () => {
    it('round-trips through a single hash key', async () => {
      const { cache, redis } = await connected();
      await cache.setCommunity(snapshot);

      await expect(cache.getCommunity()).resolves.toEqual(snapshot);
      expect(redis.hashes.get('test:community')?.['domains']).toBe('a.com\nb.com');
    });

    it('uses the default key prefix', async () => {
      const redis = new FakeRedis();
      const cache = new RedisCache({ client: redis });
      await cache.connect();
      await cache.setCommunity(snapshot);

      expect(redis.hashes.has('mailsniff:v1:community')).toBe(true);
    });

    it('round-trips a snapshot without an etag', async () => {
      const { cache } = await connected();
      await cache.setCommunity({ domains: ['a.com'], fetchedAt: 5 });

      await expect(cache.getCommunity()).resolves.toEqual({ domains: ['a.com'], fetchedAt: 5 });
    });

    it('replaces the previous snapshot entirely', async () => {
      const { cache } = await connected();
      await cache.setCommunity(snapshot);
      await cache.setCommunity({ domains: ['c.com'], fetchedAt: 2000 });

      await expect(cache.getCommunity()).resolves.toEqual({ domains: ['c.com'], fetchedAt: 2000 });
    });

    it('treats a missing record as a cache miss', async () => {
      const { cache } = await connected();

      await expect(cache.getCommunity()).resolves.toBeNull();
    });

    it('treats a corrupted record as a cache miss', async () => {
      const { cache, redis } = await connected();
      redis.hashes.set('test:community', { domains: 'a.com', fetchedAt: 'not-a-number' });

      await expect(cache.getCommunity()).resolves.toBeNull();
    });
  });

  describe('custom domains', () => {
    it('adds, de-duplicates and removes', async () => {
      const { cache } = await connected();
      await cache.addCustomDomains(['x.test', 'y.test', 'x.test']);
      await cache.removeCustomDomains(['x.test']);

      await expect(cache.getCustomDomains()).resolves.toEqual(['y.test']);
    });

    it('does nothing for empty input', async () => {
      const { cache, redis } = await connected();
      await cache.addCustomDomains([]);
      await cache.removeCustomDomains([]);

      expect(redis.execCount).toBe(0);
    });

    it('stores large batches in one transaction', async () => {
      const { cache, redis } = await connected();
      const domains = Array.from({ length: 1200 }, (_unused, index) => `d${index}.test`);
      await cache.addCustomDomains(domains);

      expect(redis.sets.get('test:custom')?.size).toBe(1200);
      expect(redis.execCount).toBe(1);
    });

    it('is untouched by community writes and by clear() defaults', async () => {
      const { cache } = await connected();
      await cache.addCustomDomains(['x.test']);
      await cache.setCommunity(snapshot);
      await cache.clear({ includeCustom: false });

      await expect(cache.getCommunity()).resolves.toBeNull();
      await expect(cache.getCustomDomains()).resolves.toEqual(['x.test']);
    });

    it('clear({ includeCustom: true }) removes both', async () => {
      const { cache } = await connected();
      await cache.addCustomDomains(['x.test']);
      await cache.setCommunity(snapshot);
      await cache.clear({ includeCustom: true });

      await expect(cache.getCommunity()).resolves.toBeNull();
      await expect(cache.getCustomDomains()).resolves.toEqual([]);
    });
  });

  describe('version', () => {
    it('is null before any write and changes with every write', async () => {
      const { cache } = await connected();
      const versions: Array<string | null> = [await cache.getVersion()];

      await cache.setCommunity(snapshot);
      versions.push(await cache.getVersion());
      await cache.addCustomDomains(['x.test']);
      versions.push(await cache.getVersion());
      await cache.removeCustomDomains(['x.test']);
      versions.push(await cache.getVersion());
      await cache.clear({ includeCustom: false });
      versions.push(await cache.getVersion());

      expect(versions[0]).toBeNull();
      expect(new Set(versions).size).toBe(5);
    });
  });

  describe('failures', () => {
    it('wraps command errors in a CacheError with the cause', async () => {
      const { cache, redis } = await connected();
      const cause = new Error('ECONNRESET');
      redis.failWith = cause;

      const error: unknown = await cache.getCommunity().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CacheError);
      expect((error as CacheError).cause).toBe(cause);
    });

    it.each([
      ['getCustomDomains', (cache: RedisCache) => cache.getCustomDomains()],
      ['addCustomDomains', (cache: RedisCache) => cache.addCustomDomains(['x.test'])],
      ['setCommunity', (cache: RedisCache) => cache.setCommunity(snapshot)],
      ['clear', (cache: RedisCache) => cache.clear({ includeCustom: true })],
      ['getVersion', (cache: RedisCache) => cache.getVersion()],
      ['acquireRefreshLock', (cache: RedisCache) => cache.acquireRefreshLock(1000)],
    ])('%s rejects with CacheError when Redis is down', async (_name, operation) => {
      const { cache, redis } = await connected();
      redis.failWith = new Error('down');

      await expect(operation(cache)).rejects.toBeInstanceOf(CacheError);
    });

    it('fails writes when the transaction is aborted', async () => {
      const { cache, redis } = await connected();
      redis.abortTransactions = true;

      await expect(cache.addCustomDomains(['x.test'])).rejects.toThrow(/aborted/);
    });

    it('fails writes when a command inside the transaction errors', async () => {
      const { cache, redis } = await connected();
      redis.pipelineError = new Error('WRONGTYPE');

      await expect(cache.setCommunity(snapshot)).rejects.toThrow(/WRONGTYPE/);
    });

    it('does not apply partial data when a write fails', async () => {
      const { cache, redis } = await connected();
      redis.pipelineError = new Error('WRONGTYPE');
      await cache.setCommunity(snapshot).catch(() => undefined);

      expect(redis.hashes.has('test:community')).toBe(false);
    });
  });

  describe('refresh lock', () => {
    it('is exclusive until released and carries the TTL', async () => {
      const { cache, redis } = await connected();
      const lock = await cache.acquireRefreshLock(5000);

      expect(lock).not.toBeNull();
      expect(redis.lockTtls.get('test:lock')).toBe(5000);
      await expect(cache.acquireRefreshLock(5000)).resolves.toBeNull();

      await lock!.release();

      await expect(cache.acquireRefreshLock(5000)).resolves.not.toBeNull();
    });

    it('does not release a lock that has been taken over', async () => {
      const { cache, redis } = await connected();
      const lock = await cache.acquireRefreshLock(5000);
      redis.strings.set('test:lock', 'another-holder');

      await lock!.release();

      expect(redis.strings.get('test:lock')).toBe('another-holder');
    });

    it('reports a failed release instead of throwing', async () => {
      const onError = vi.fn();
      const { cache, redis } = await connected({ onError });
      const lock = await cache.acquireRefreshLock(5000);
      redis.failWith = new Error('down');

      await expect(lock!.release()).resolves.toBeUndefined();
      expect(onError).toHaveBeenCalledWith(expect.any(CacheError));
    });
  });

  describe('close', () => {
    it('quits a client it created', async () => {
      const redis = new FakeRedis();
      const cache = new RedisCache({
        url: 'redis://x',
        createClient: () => Promise.resolve(redis),
      });
      await cache.connect();
      await cache.close();

      expect(redis.quitCalls).toBe(1);
      expect(cache.isHealthy()).toBe(false);
    });

    it('falls back to disconnect when quit fails', async () => {
      const redis = new FakeRedis();
      redis.quitFails = true;
      const cache = new RedisCache({
        url: 'redis://x',
        createClient: () => Promise.resolve(redis),
      });
      await cache.connect();
      await cache.close();

      expect(redis.disconnectCalls).toBe(1);
    });

    it('leaves a client that was passed in open', async () => {
      const { cache, redis } = await connected();
      await cache.close();

      expect(redis.quitCalls).toBe(0);
      expect(redis.disconnectCalls).toBe(0);
    });

    it('is idempotent and rejects operations afterwards', async () => {
      const redis = new FakeRedis();
      const cache = new RedisCache({
        url: 'redis://x',
        createClient: () => Promise.resolve(redis),
      });
      await cache.connect();
      await cache.close();
      await cache.close();

      expect(redis.quitCalls).toBe(1);
      await expect(cache.getCommunity()).rejects.toThrow(CacheError);
    });
  });

  describe('client error events', () => {
    async function ownedClient(onError: (error: Error) => void): Promise<FakeRedis> {
      const redis = new FakeRedis();
      const cache = new RedisCache({
        url: 'redis://x',
        createClient: () => Promise.resolve(redis),
        onError,
      });
      await cache.connect();
      return redis;
    }

    it('reports the first error of an outage only, until the client is ready again', async () => {
      const onError = vi.fn();
      const redis = await ownedClient(onError);

      redis.emit('error', new Error('ECONNREFUSED'));
      redis.emit('error', new Error('ECONNREFUSED'));
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]![0]).toBeInstanceOf(CacheError);

      redis.emit('ready');
      redis.emit('error', new Error('ECONNRESET'));
      expect(onError).toHaveBeenCalledTimes(2);
    });

    it('does not attach listeners to a client it does not own', async () => {
      const { redis } = await connected({ onError: vi.fn() });

      expect(redis.listenerCount('error')).toBe(0);
    });
  });
});
