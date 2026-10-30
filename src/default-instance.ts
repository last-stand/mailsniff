import { ConfigError } from './errors';
import { MailSniff } from './mailsniff';
import type { ClearCacheOptions, MailSniffOptions, MailSniffStatus, RefreshResult } from './types';

/**
 * Lazily created singleton behind the top-level functions, for the quick-start use case.
 * Applications that need several configurations should use `createMailSniff()` instead.
 */
let defaultInstance: MailSniff | undefined;

function getDefaultInstance(): MailSniff {
  defaultInstance ??= new MailSniff();
  return defaultInstance;
}

/**
 * Configures the default instance. Call it once at startup, before any other function
 * (or again after `close()`).
 * @throws {ConfigError} when the options are invalid or the default instance is already in use.
 */
export function configure(options: MailSniffOptions): void {
  if (defaultInstance) {
    throw new ConfigError(
      'configure() must be called before the default instance is used, or after close()',
    );
  }
  defaultInstance = new MailSniff(options);
}

export function init(): Promise<void> {
  return getDefaultInstance().init();
}

export function isDisposableEmail(email: string): Promise<boolean> {
  return getDefaultInstance().isDisposableEmail(email);
}

export function isDisposableDomain(domain: string): Promise<boolean> {
  return getDefaultInstance().isDisposableDomain(domain);
}

export function listDisposableDomains(): Promise<string[]> {
  return getDefaultInstance().listDisposableDomains();
}

export function addDisposableDomains(domains: string | readonly string[]): Promise<void> {
  return getDefaultInstance().addDisposableDomains(domains);
}

export function removeDisposableDomains(domains: string | readonly string[]): Promise<void> {
  return getDefaultInstance().removeDisposableDomains(domains);
}

export function refresh(): Promise<RefreshResult> {
  return getDefaultInstance().refresh();
}

export function clearCache(options?: ClearCacheOptions): Promise<void> {
  return getDefaultInstance().clearCache(options);
}

/**
 * Does not create the default instance: before first use it reports a pristine,
 * unconfigured one, so `configure()` can still be called afterwards.
 */
export function status(): MailSniffStatus {
  return (defaultInstance ?? new MailSniff()).status();
}

/** Closes the default instance. A later call creates a fresh one (or call `configure()` first). */
export async function close(): Promise<void> {
  const instance = defaultInstance;
  defaultInstance = undefined;
  await instance?.close();
}
