import { DEFAULT_REDIS_CONNECT_TIMEOUT_MS } from '../constants';
import { ConfigError } from '../errors';
import { resolveRedisConstructor } from './redis-client';
import type { RedisClientLike } from './redis-client';

/**
 * Loads `ioredis` on demand, so users who never configure Redis never need it installed.
 * Covered by the integration tests (it needs the real package).
 */
export async function createIoredisClient(url: string): Promise<RedisClientLike> {
  let moduleExports: unknown;
  try {
    moduleExports = await import('ioredis');
  } catch (error) {
    throw new ConfigError(
      'Redis support requires the optional "ioredis" package. Install it with `pnpm add ioredis` (or `npm install ioredis`).',
      { cause: error },
    );
  }

  const RedisClient = resolveRedisConstructor(moduleExports);
  if (!RedisClient) {
    throw new ConfigError('Could not find the Redis client class in the "ioredis" package.');
  }

  return new RedisClient(url, {
    connectTimeout: DEFAULT_REDIS_CONNECT_TIMEOUT_MS,
    // Fail commands quickly during an outage instead of queueing them forever.
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 5_000),
  });
}
