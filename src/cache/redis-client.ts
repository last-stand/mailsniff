/** The pipeline subset used for atomic (MULTI/EXEC) writes. */
export interface RedisPipelineLike {
  hset(key: string, data: Record<string, string>): RedisPipelineLike;
  sadd(key: string, ...members: string[]): RedisPipelineLike;
  srem(key: string, ...members: string[]): RedisPipelineLike;
  del(...keys: string[]): RedisPipelineLike;
  incr(key: string): RedisPipelineLike;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

/**
 * The narrow slice of a Redis client that MailSniff needs. An `ioredis` instance
 * satisfies it, and so can any client wrapped to match.
 */
export interface RedisClientLike {
  readonly status?: string;
  connect?(): Promise<void>;
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttlMs: number, flag: 'NX'): Promise<'OK' | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  smembers(key: string): Promise<string[]>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  multi(): RedisPipelineLike;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'ready', listener: () => void): unknown;
  quit(): Promise<unknown>;
  disconnect(): void;
}

export type RedisClientConstructor = new (
  url: string,
  options?: Record<string, unknown>,
) => RedisClientLike;

function isConstructor(value: unknown): value is RedisClientConstructor {
  return typeof value === 'function';
}

/**
 * Finds the client class in whatever shape the dynamic `import('ioredis')` produced:
 * the class itself, `{ Redis }`, `{ default }` or `{ default: { Redis } }`.
 */
export function resolveRedisConstructor(moduleExports: unknown): RedisClientConstructor | null {
  if (isConstructor(moduleExports)) {
    return moduleExports;
  }
  if (typeof moduleExports !== 'object' || moduleExports === null) {
    return null;
  }

  const record = moduleExports as Record<string, unknown>;
  const fallback = record['default'];
  const nested =
    typeof fallback === 'object' || typeof fallback === 'function'
      ? (fallback as Record<string, unknown> | null)?.['Redis']
      : undefined;

  return [record['Redis'], fallback, nested].find(isConstructor) ?? null;
}
