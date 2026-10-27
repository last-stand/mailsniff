import { EventEmitter } from 'node:events';
import type { RedisClientLike, RedisPipelineLike } from '../../src/cache/redis-client';

type Operation = () => unknown;

class FakePipeline implements RedisPipelineLike {
  private readonly operations: Operation[] = [];

  constructor(private readonly redis: FakeRedis) {}

  hset(key: string, data: Record<string, string>): this {
    this.operations.push(() => {
      this.redis.hashes.set(key, { ...this.redis.hashes.get(key), ...data });
      return Object.keys(data).length;
    });
    return this;
  }

  sadd(key: string, ...members: string[]): this {
    this.operations.push(() => {
      const set = this.redis.sets.get(key) ?? new Set<string>();
      members.forEach((member) => set.add(member));
      this.redis.sets.set(key, set);
      return members.length;
    });
    return this;
  }

  srem(key: string, ...members: string[]): this {
    this.operations.push(() => {
      const set = this.redis.sets.get(key);
      members.forEach((member) => set?.delete(member));
      return members.length;
    });
    return this;
  }

  del(...keys: string[]): this {
    this.operations.push(() => {
      keys.forEach((key) => {
        this.redis.hashes.delete(key);
        this.redis.sets.delete(key);
        this.redis.strings.delete(key);
      });
      return keys.length;
    });
    return this;
  }

  incr(key: string): this {
    this.operations.push(() => {
      const next = Number(this.redis.strings.get(key) ?? '0') + 1;
      this.redis.strings.set(key, String(next));
      return next;
    });
    return this;
  }

  exec(): Promise<Array<[Error | null, unknown]> | null> {
    return this.redis.runTransaction(this.operations);
  }
}

/** In-memory stand-in for the Redis commands MailSniff uses, with failure injection. */
export class FakeRedis extends EventEmitter implements RedisClientLike {
  status = 'ready';

  /** Every command rejects with this error while set. */
  failWith: Error | null = null;
  hangPing = false;
  quitFails = false;
  /** `exec()` resolves `null`, as when a transaction is aborted. */
  abortTransactions = false;
  /** `exec()` reports this error for the first command instead of applying anything. */
  pipelineError: Error | null = null;

  execCount = 0;
  quitCalls = 0;
  disconnectCalls = 0;
  connectCalls = 0;
  readonly lockTtls = new Map<string, number>();

  readonly hashes = new Map<string, Record<string, string>>();
  readonly sets = new Map<string, Set<string>>();
  readonly strings = new Map<string, string>();

  connect(): Promise<void> {
    this.connectCalls += 1;
    this.status = 'ready';
    return Promise.resolve();
  }

  ping(): Promise<string> {
    if (this.hangPing) {
      return new Promise<string>(() => undefined);
    }
    return this.respond(() => 'PONG');
  }

  get(key: string): Promise<string | null> {
    return this.respond(() => this.strings.get(key) ?? null);
  }

  set(key: string, value: string, _mode: 'PX', ttlMs: number, _flag: 'NX'): Promise<'OK' | null> {
    return this.respond(() => {
      if (this.strings.has(key)) {
        return null;
      }
      this.strings.set(key, value);
      this.lockTtls.set(key, ttlMs);
      return 'OK';
    });
  }

  hgetall(key: string): Promise<Record<string, string>> {
    return this.respond(() => ({ ...this.hashes.get(key) }));
  }

  smembers(key: string): Promise<string[]> {
    return this.respond(() => [...(this.sets.get(key) ?? [])]);
  }

  /** Implements only the compare-and-delete release script. */
  eval(_script: string, _numKeys: number, ...args: string[]): Promise<unknown> {
    return this.respond(() => {
      const [key, token] = args;
      if (key !== undefined && this.strings.get(key) === token) {
        this.strings.delete(key);
        return 1;
      }
      return 0;
    });
  }

  multi(): RedisPipelineLike {
    return new FakePipeline(this);
  }

  quit(): Promise<unknown> {
    this.quitCalls += 1;
    if (this.quitFails) {
      return Promise.reject(new Error('quit failed'));
    }
    this.status = 'end';
    return Promise.resolve('OK');
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.status = 'end';
  }

  runTransaction(operations: readonly Operation[]): Promise<Array<[Error | null, unknown]> | null> {
    this.execCount += 1;
    if (this.failWith) {
      return Promise.reject(this.failWith);
    }
    if (this.abortTransactions) {
      return Promise.resolve(null);
    }
    if (this.pipelineError) {
      return Promise.resolve([[this.pipelineError, undefined]]);
    }
    return Promise.resolve(
      operations.map((operation): [Error | null, unknown] => [null, operation()]),
    );
  }

  private respond<T>(produce: () => T): Promise<T> {
    return this.failWith ? Promise.reject(this.failWith) : Promise.resolve(produce());
  }
}
