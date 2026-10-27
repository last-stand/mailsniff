import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../../../src/cache/memory-cache';
import { resolveOptions } from '../../../src/config/options';
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_DATASET_BYTES,
  DEFAULT_MIN_DOMAINS,
  DEFAULT_REDIS_KEY_PREFIX,
  DEFAULT_SOURCE_URL,
} from '../../../src/constants';
import { ConfigError } from '../../../src/errors';
import type { MailSniffOptions } from '../../../src/types';
import { FakeRedis } from '../../helpers/fake-redis';

const asOptions = (value: unknown): MailSniffOptions => value as MailSniffOptions;

describe('resolveOptions', () => {
  it('applies defaults', () => {
    const resolved = resolveOptions();

    expect(resolved).toMatchObject({
      matchSubdomains: true,
      failOnInitError: false,
      redis: undefined,
      cache: undefined,
      dataset: {
        sourceUrl: DEFAULT_SOURCE_URL,
        timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
        maxBytes: DEFAULT_MAX_DATASET_BYTES,
        minDomains: DEFAULT_MIN_DOMAINS,
        fetch: undefined,
      },
    });
    expect(() => resolved.onError(new Error('ignored'))).not.toThrow();
  });

  it('points at the raw GitHub URL, not the HTML page', () => {
    expect(DEFAULT_SOURCE_URL).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
  });

  it('respects explicit values', () => {
    const onError = (): void => undefined;
    const fetch = () => Promise.reject(new Error('unused'));
    const cache = new MemoryCache();

    const resolved = resolveOptions({
      matchSubdomains: false,
      failOnInitError: true,
      onError,
      cache,
      dataset: {
        sourceUrl: 'http://mirror.test/list',
        timeoutMs: 5,
        maxBytes: 10,
        minDomains: 2,
        fetch,
      },
    });

    expect(resolved).toMatchObject({
      matchSubdomains: false,
      failOnInitError: true,
      onError,
      cache,
    });
    expect(resolved.dataset).toEqual({
      sourceUrl: 'http://mirror.test/list',
      timeoutMs: 5,
      maxBytes: 10,
      minDomains: 2,
      fetch,
    });
  });

  describe('redis', () => {
    it.each(['redis://localhost:6379', 'rediss://user:pass@host:6380/1'])(
      'accepts the url %s',
      (url) => {
        expect(resolveOptions({ redis: { url } }).redis).toEqual({
          url,
          keyPrefix: DEFAULT_REDIS_KEY_PREFIX,
        });
      },
    );

    it('accepts a client and a custom key prefix', () => {
      const client = new FakeRedis();

      expect(resolveOptions({ redis: { client, keyPrefix: 'app' } }).redis).toEqual({
        client,
        keyPrefix: 'app',
      });
    });

    it('explains the likely cause when REDIS_URL is unset', () => {
      expect(() => resolveOptions({ redis: { url: undefined } })).toThrow(/REDIS_URL/);
    });

    it('never leaks credentials in error messages', () => {
      expect(() => resolveOptions({ redis: { url: 'http://user:secret@host' } })).toThrow(
        ConfigError,
      );
      expect(() => resolveOptions({ redis: { url: 'http://user:secret@host' } })).not.toThrow(
        /secret/,
      );
    });
  });

  it.each([
    ['null options', null],
    ['non-boolean matchSubdomains', { matchSubdomains: 'yes' }],
    ['non-boolean failOnInitError', { failOnInitError: 1 }],
    ['non-function onError', { onError: 'log' }],
    ['non-object dataset', { dataset: 'x' }],
    ['malformed sourceUrl', { dataset: { sourceUrl: 'not a url' } }],
    ['non-http sourceUrl', { dataset: { sourceUrl: 'ftp://host/list' } }],
    ['zero timeout', { dataset: { timeoutMs: 0 } }],
    ['negative timeout', { dataset: { timeoutMs: -1 } }],
    ['fractional timeout', { dataset: { timeoutMs: 1.5 } }],
    ['zero maxBytes', { dataset: { maxBytes: 0 } }],
    ['zero minDomains', { dataset: { minDomains: 0 } }],
    ['non-function fetch', { dataset: { fetch: 'x' } }],
    ['non-object redis', { redis: 'redis://localhost' }],
    ['empty redis config', { redis: {} }],
    ['redis url and client together', { redis: { url: 'redis://h', client: new FakeRedis() } }],
    ['empty redis url', { redis: { url: '' } }],
    ['non-redis url scheme', { redis: { url: 'http://localhost' } }],
    ['invalid redis client', { redis: { client: {} } }],
    ['empty key prefix', { redis: { url: 'redis://h', keyPrefix: ' ' } }],
    ['invalid cache', { cache: {} }],
    ['redis together with cache', { redis: { url: 'redis://h' }, cache: new MemoryCache() }],
  ])('rejects %s', (_label, options) => {
    expect(() => resolveOptions(asOptions(options))).toThrow(ConfigError);
  });
});
