import { randomUUID } from 'node:crypto';
import { DEFAULT_REDIS_CONNECT_TIMEOUT_MS, DEFAULT_REDIS_KEY_PREFIX } from '../constants';
import { CacheError, ConfigError, MailSniffError } from '../errors';
import { chunk } from '../utils/chunk';
import { errorMessage } from '../utils/error';
import { withTimeout } from '../utils/timeout';
import type { CommunitySnapshot, DomainCache, RefreshLock } from './domain-cache';
import { createIoredisClient } from './ioredis-loader';
import type { RedisClientLike } from './redis-client';

/** Compare-and-delete, so a holder can only release its own lock. */
const RELEASE_LOCK_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

/** Redis accepts large argument lists, but keeping commands small avoids latency spikes. */
const MEMBERS_PER_COMMAND = 500;

export interface RedisCacheOptions {
  /** Connection URL. MailSniff creates (and later closes) the client. */
  readonly url?: string;
  /** An existing client. MailSniff never closes a client it did not create. */
  readonly client?: RedisClientLike;
  readonly keyPrefix?: string;
  readonly connectTimeoutMs?: number;
  readonly onError?: (error: Error) => void;
  /** Overrides how a client is created from `url` (used by tests). */
  readonly createClient?: (url: string) => Promise<RedisClientLike>;
}

/**
 * Redis data model (all keys share `keyPrefix`):
 *  - `community` HASH: `domains` (newline-delimited), `etag`, `fetchedAt`. Written with a
 *    single HSET, so readers never observe a half-written list.
 *  - `custom` SET: user-added domains, never touched by community refreshes.
 *  - `version` STRING: incremented in the same transaction as every data change.
 *  - `lock` STRING: refresh lock (SET NX PX).
 */
export class RedisCache implements DomainCache {
  readonly kind = 'redis' as const;

  private client: RedisClientLike | undefined;
  private readonly ownsClient: boolean;
  private readonly url: string;
  private readonly connectTimeoutMs: number;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly createClient: (url: string) => Promise<RedisClientLike>;
  private readonly keys: { community: string; custom: string; version: string; lock: string };
  private closed = false;
  private errorReported = false;

  constructor(options: RedisCacheOptions) {
    if (!options.client && !options.url) {
      throw new ConfigError('RedisCache requires either a "client" or a "url"');
    }

    const prefix = options.keyPrefix ?? DEFAULT_REDIS_KEY_PREFIX;
    this.client = options.client;
    this.ownsClient = options.client === undefined;
    this.url = options.url ?? '';
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_REDIS_CONNECT_TIMEOUT_MS;
    this.onError = options.onError;
    this.createClient = options.createClient ?? createIoredisClient;
    this.keys = {
      community: `${prefix}:community`,
      custom: `${prefix}:custom`,
      version: `${prefix}:version`,
      lock: `${prefix}:lock`,
    };
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new CacheError('Cannot connect: the Redis cache has been closed');
    }

    if (!this.client) {
      // A ConfigError (for example a missing `ioredis`) propagates unchanged on purpose.
      this.client = await this.createClient(this.url);
      this.client.on('error', this.handleClientError);
      this.client.on('ready', this.handleClientReady);
    }

    const client = this.client;
    try {
      if (client.status === 'wait' && client.connect) {
        await client.connect();
      }
      await withTimeout(
        client.ping(),
        this.connectTimeoutMs,
        () => new Error(`no reply within ${this.connectTimeoutMs}ms`),
      );
    } catch (error) {
      // The client is kept: it keeps reconnecting in the background according to its own strategy.
      throw new CacheError(`Could not connect to Redis: ${errorMessage(error)}`, { cause: error });
    }
  }

  getCommunity(): Promise<CommunitySnapshot | null> {
    return this.run('read the community list', async (client) => {
      const hash = await client.hgetall(this.keys.community);
      const raw = hash['domains'];
      const fetchedAt = Number(hash['fetchedAt']);

      // A missing or corrupted record is treated as a cache miss, which triggers a re-download.
      if (!raw || !Number.isFinite(fetchedAt)) {
        return null;
      }

      const etag = hash['etag'];
      return {
        domains: raw.split('\n').filter((domain) => domain.length > 0),
        etag: etag === undefined || etag === '' ? undefined : etag,
        fetchedAt,
      };
    });
  }

  setCommunity(snapshot: CommunitySnapshot): Promise<void> {
    return this.run('write the community list', async (client) => {
      const results = await client
        .multi()
        .hset(this.keys.community, {
          domains: snapshot.domains.join('\n'),
          etag: snapshot.etag ?? '',
          fetchedAt: String(snapshot.fetchedAt),
        })
        .incr(this.keys.version)
        .exec();
      assertTransactionSucceeded(results);
    });
  }

  getCustomDomains(): Promise<string[]> {
    return this.run('read custom domains', (client) => client.smembers(this.keys.custom));
  }

  addCustomDomains(domains: readonly string[]): Promise<void> {
    return this.mutateCustom('add custom domains', domains, (pipeline, batch) =>
      pipeline.sadd(this.keys.custom, ...batch),
    );
  }

  removeCustomDomains(domains: readonly string[]): Promise<void> {
    return this.mutateCustom('remove custom domains', domains, (pipeline, batch) =>
      pipeline.srem(this.keys.custom, ...batch),
    );
  }

  getVersion(): Promise<string | null> {
    return this.run('read the cache version', (client) => client.get(this.keys.version));
  }

  async acquireRefreshLock(ttlMs: number): Promise<RefreshLock | null> {
    const token = randomUUID();
    const reply = await this.run('acquire the refresh lock', (client) =>
      client.set(this.keys.lock, token, 'PX', ttlMs, 'NX'),
    );
    if (reply !== 'OK') {
      return null;
    }

    return {
      release: async (): Promise<void> => {
        try {
          await this.run('release the refresh lock', (client) =>
            client.eval(RELEASE_LOCK_SCRIPT, 1, this.keys.lock, token),
          );
        } catch (error) {
          // The lock expires on its own, so a failed release is only worth reporting.
          this.onError?.(error instanceof Error ? error : new CacheError(String(error)));
        }
      },
    };
  }

  clear(options: { includeCustom: boolean }): Promise<void> {
    return this.run('clear the cache', async (client) => {
      const keys = options.includeCustom
        ? [this.keys.community, this.keys.custom]
        : [this.keys.community];
      const results = await client
        .multi()
        .del(...keys)
        .incr(this.keys.version)
        .exec();
      assertTransactionSucceeded(results);
    });
  }

  isHealthy(): boolean {
    return !this.closed && this.client?.status === 'ready';
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    const client = this.client;
    if (!client || !this.ownsClient) {
      return;
    }

    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }

  private async mutateCustom(
    action: string,
    domains: readonly string[],
    apply: (
      pipeline: ReturnType<RedisClientLike['multi']>,
      batch: string[],
    ) => ReturnType<RedisClientLike['multi']>,
  ): Promise<void> {
    if (domains.length === 0) {
      return;
    }

    await this.run(action, async (client) => {
      let pipeline = client.multi();
      for (const batch of chunk(domains, MEMBERS_PER_COMMAND)) {
        pipeline = apply(pipeline, batch);
      }
      assertTransactionSucceeded(await pipeline.incr(this.keys.version).exec());
    });
  }

  private async run<T>(
    action: string,
    operation: (client: RedisClientLike) => Promise<T>,
  ): Promise<T> {
    const client = this.client;
    if (!client || this.closed) {
      throw new CacheError(`Cannot ${action}: the Redis cache is not connected`);
    }

    try {
      return await operation(client);
    } catch (error) {
      if (error instanceof MailSniffError) {
        throw error;
      }
      throw new CacheError(`Redis failed to ${action}: ${errorMessage(error)}`, { cause: error });
    }
  }

  /** Reports the first error of an outage only; `ready` re-arms it. Avoids log floods while reconnecting. */
  private readonly handleClientError = (error: Error): void => {
    if (this.errorReported) {
      return;
    }
    this.errorReported = true;
    this.onError?.(new CacheError(`Redis client error: ${error.message}`, { cause: error }));
  };

  private readonly handleClientReady = (): void => {
    this.errorReported = false;
  };
}

function assertTransactionSucceeded(results: Array<[Error | null, unknown]> | null): void {
  if (results === null) {
    throw new Error('transaction was aborted');
  }
  for (const [error] of results) {
    if (error) {
      throw error;
    }
  }
}
