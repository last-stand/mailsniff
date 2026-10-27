import { MailSniff } from './mailsniff';
import type { MailSniffOptions } from './types';

export {
  CacheError,
  ClosedError,
  ConfigError,
  DatasetError,
  MailSniffError,
  ValidationError,
} from './errors';
export type { MailSniffErrorCode } from './errors';

export { MailSniff } from './mailsniff';
export {
  addDisposableDomains,
  clearCache,
  close,
  configure,
  init,
  isDisposableDomain,
  isDisposableEmail,
  listDisposableDomains,
  removeDisposableDomains,
  status,
} from './default-instance';

export type { CommunitySnapshot, DomainCache, RefreshLock } from './cache/domain-cache';
export type { RedisClientLike, RedisPipelineLike } from './cache/redis-client';
export type { FetchLike, ResponseLike } from './dataset/fetcher';
export type {
  ClearCacheOptions,
  DatasetOptions,
  Interval,
  MailSniffOptions,
  MailSniffState,
  MailSniffStatus,
  RedisConfig,
} from './types';

/** Creates an independent instance with its own configuration and cache. */
export function createMailSniff(options?: MailSniffOptions): MailSniff {
  return new MailSniff(options);
}
