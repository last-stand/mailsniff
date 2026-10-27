import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import type { RedisClientLike } from '../../../src/cache/redis-client';

describe('RedisClientLike', () => {
  // Compile-time check (run by `pnpm typecheck`): a real ioredis client must be assignable,
  // otherwise `redis: { client }` would be unusable for TypeScript users.
  it('is satisfied by an ioredis client', () => {
    const accepts = (client: RedisClientLike): RedisClientLike => client;
    const assertCompatible = (client: Redis): RedisClientLike => accepts(client);

    expect(typeof assertCompatible).toBe('function');
  });
});
