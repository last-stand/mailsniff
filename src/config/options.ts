import type { DomainCache } from '../cache/domain-cache';
import type { RedisClientLike } from '../cache/redis-client';
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_DATASET_BYTES,
  DEFAULT_MIN_DOMAINS,
  DEFAULT_REDIS_KEY_PREFIX,
  DEFAULT_SOURCE_URL,
} from '../constants';
import type { FetchLike } from '../dataset/fetcher';
import { ConfigError } from '../errors';
import type { DatasetOptions, Interval, MailSniffOptions } from '../types';

type IntervalUnit = 'm' | 'h' | 'd';

const MS_PER_UNIT: Record<IntervalUnit, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Refreshing more often than this would hammer the source for no benefit. */
export const MIN_REFRESH_INTERVAL_MS = MS_PER_UNIT.m;

/**
 * `setTimeout` overflows above 2^31-1 ms (~24.8 days) and fires immediately,
 * which would turn a long interval into a busy loop. 24 days stays safely below it.
 */
export const MAX_REFRESH_INTERVAL_MS = 24 * MS_PER_UNIT.d;

const INTERVAL_PATTERN = /^(\d+)(m|h|d)$/;

function toMilliseconds(value: unknown, optionName: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const match = INTERVAL_PATTERN.exec(value.trim().toLowerCase());
    if (match) {
      const [, amount = '', unit = ''] = match;
      return Number(amount) * MS_PER_UNIT[unit as IntervalUnit];
    }
  }

  throw new ConfigError(
    `${optionName} must be a number of milliseconds or a string like "30m", "12h" or "1d" (got ${String(value)})`,
  );
}

/**
 * Converts an {@link Interval} to milliseconds and enforces the supported range.
 * @throws {ConfigError} when the value is malformed or outside 1 minute – 24 days.
 */
export function parseInterval(value: Interval, optionName = 'refreshInterval'): number {
  const ms = toMilliseconds(value, optionName);

  if (ms < MIN_REFRESH_INTERVAL_MS || ms > MAX_REFRESH_INTERVAL_MS) {
    throw new ConfigError(`${optionName} must be between 1m and 24d (got ${String(value)})`);
  }

  return ms;
}

export interface ResolvedDatasetOptions {
  readonly sourceUrl: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly minDomains: number;
  readonly fetch: FetchLike | undefined;
}

export interface ResolvedRedisOptions {
  readonly url?: string;
  readonly client?: RedisClientLike;
  readonly keyPrefix: string;
}

export interface ResolvedOptions {
  readonly matchSubdomains: boolean;
  readonly failOnInitError: boolean;
  readonly refreshIntervalMs: number | undefined;
  readonly onError: (error: Error) => void;
  readonly dataset: ResolvedDatasetOptions;
  readonly redis: ResolvedRedisOptions | undefined;
  readonly cache: DomainCache | undefined;
}

const noop = (): void => undefined;

function readBoolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${name} must be a boolean`);
  }
  return value;
}

function readPositiveInteger(value: unknown, name: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${name} must be a positive integer`);
  }
  return value;
}

/** Error messages never echo URLs: they may contain credentials. */
function assertUrl(
  value: unknown,
  name: string,
  protocols: readonly string[],
): asserts value is string {
  let protocol: string | undefined;
  if (typeof value === 'string') {
    try {
      protocol = new URL(value).protocol;
    } catch {
      protocol = undefined;
    }
  }

  if (protocol === undefined || !protocols.includes(protocol)) {
    const expected = protocols.map((entry) => `${entry}//`).join(' or ');
    throw new ConfigError(`${name} must be a valid URL starting with ${expected}`);
  }
}

function resolveDataset(input: DatasetOptions | undefined): ResolvedDatasetOptions {
  if (input !== undefined && (typeof input !== 'object' || input === null)) {
    throw new ConfigError('dataset must be an object');
  }
  const dataset = input ?? {};

  const sourceUrl = dataset.sourceUrl ?? DEFAULT_SOURCE_URL;
  assertUrl(sourceUrl, 'dataset.sourceUrl', ['https:', 'http:']);

  if (dataset.fetch !== undefined && typeof dataset.fetch !== 'function') {
    throw new ConfigError('dataset.fetch must be a function');
  }

  return {
    sourceUrl,
    timeoutMs: readPositiveInteger(
      dataset.timeoutMs,
      'dataset.timeoutMs',
      DEFAULT_FETCH_TIMEOUT_MS,
    ),
    maxBytes: readPositiveInteger(dataset.maxBytes, 'dataset.maxBytes', DEFAULT_MAX_DATASET_BYTES),
    minDomains: readPositiveInteger(dataset.minDomains, 'dataset.minDomains', DEFAULT_MIN_DOMAINS),
    fetch: dataset.fetch,
  };
}

const REQUIRED_CLIENT_METHODS = [
  'ping',
  'get',
  'set',
  'hgetall',
  'smembers',
  'eval',
  'multi',
  'quit',
];

function isRedisClientLike(value: unknown): value is RedisClientLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    REQUIRED_CLIENT_METHODS.every(
      (method) => typeof (value as Record<string, unknown>)[method] === 'function',
    )
  );
}

function resolveRedis(input: unknown): ResolvedRedisOptions | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input !== 'object' || input === null) {
    throw new ConfigError('redis must be an object with either a "url" or a "client"');
  }

  const { url, client, keyPrefix } = input as {
    url?: unknown;
    client?: unknown;
    keyPrefix?: unknown;
  };

  if ((url === undefined) === (client === undefined)) {
    throw new ConfigError(
      'redis requires exactly one of "url" or "client" (is your REDIS_URL environment variable set?)',
    );
  }

  const prefix = keyPrefix === undefined ? DEFAULT_REDIS_KEY_PREFIX : keyPrefix;
  if (typeof prefix !== 'string' || prefix.trim() === '') {
    throw new ConfigError('redis.keyPrefix must be a non-empty string');
  }

  if (url !== undefined) {
    assertUrl(url, 'redis.url', ['redis:', 'rediss:']);
    return { url, keyPrefix: prefix };
  }

  if (!isRedisClientLike(client)) {
    throw new ConfigError('redis.client must be a Redis client (for example an ioredis instance)');
  }
  return { client, keyPrefix: prefix };
}

const CACHE_METHODS = [
  'connect',
  'getCommunity',
  'setCommunity',
  'getCustomDomains',
  'addCustomDomains',
  'removeCustomDomains',
  'getVersion',
  'acquireRefreshLock',
  'clear',
  'isHealthy',
  'close',
];

function resolveCache(input: unknown): DomainCache | undefined {
  if (input === undefined) {
    return undefined;
  }

  const valid =
    typeof input === 'object' &&
    input !== null &&
    typeof (input as Record<string, unknown>)['kind'] === 'string' &&
    CACHE_METHODS.every(
      (method) => typeof (input as Record<string, unknown>)[method] === 'function',
    );

  if (!valid) {
    throw new ConfigError('cache must implement the DomainCache interface');
  }
  return input as DomainCache;
}

/**
 * Validates user options and fills in defaults. Runs in the constructor, so a bad
 * configuration fails immediately and synchronously rather than on first use.
 * @throws {ConfigError}
 */
export function resolveOptions(options: MailSniffOptions = {}): ResolvedOptions {
  if (typeof options !== 'object' || options === null) {
    throw new ConfigError('options must be an object');
  }
  if (options.onError !== undefined && typeof options.onError !== 'function') {
    throw new ConfigError('onError must be a function');
  }

  const redis = resolveRedis(options.redis);
  const cache = resolveCache(options.cache);
  if (redis && cache) {
    throw new ConfigError('"redis" and "cache" cannot be used together');
  }

  return {
    matchSubdomains: readBoolean(options.matchSubdomains, 'matchSubdomains', true),
    failOnInitError: readBoolean(options.failOnInitError, 'failOnInitError', false),
    refreshIntervalMs:
      options.refreshInterval === undefined ? undefined : parseInterval(options.refreshInterval),
    onError: options.onError ?? noop,
    dataset: resolveDataset(options.dataset),
    redis,
    cache,
  };
}
