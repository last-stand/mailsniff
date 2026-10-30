import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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
} from '../../src/default-instance';
import type { FetchLike } from '../../src/dataset/fetcher';
import { ConfigError } from '../../src/errors';
import { makeResponse } from '../helpers/fake-fetch';
import { buildBlocklist, SAMPLE_DOMAINS } from '../helpers/fixtures';

/** The default instance uses the global fetch and the default minimum of 500 domains. */
function stubGlobalFetch() {
  const fetchMock = vi.fn<FetchLike>(() =>
    Promise.resolve(makeResponse({ body: buildBlocklist(SAMPLE_DOMAINS, 600) })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('default instance', () => {
  afterEach(async () => {
    await close();
  });

  it('is created lazily and serves detection through the top-level functions', async () => {
    const fetchMock = stubGlobalFetch();

    expect(await isDisposableDomain('mailinator.com')).toBe(true);
    expect(await isDisposableEmail('user@guerrillamail.com')).toBe(true);
    expect(await isDisposableEmail('user@gmail.com')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('manages custom domains, listing, status and clearing', async () => {
    stubGlobalFetch();
    await init();
    await addDisposableDomains(['mine.test', 'other.test']);
    await removeDisposableDomains('other.test');

    expect(await isDisposableDomain('mine.test')).toBe(true);
    expect(await isDisposableDomain('other.test')).toBe(false);
    expect(await listDisposableDomains()).toContain('mine.test');
    expect(status()).toMatchObject({ state: 'ready', backend: 'memory', customCount: 1 });

    await clearCache({ includeCustom: true });

    expect(await isDisposableDomain('mine.test')).toBe(false);
  });

  it('applies configure() before first use', async () => {
    const fetchMock = vi.fn<FetchLike>(() =>
      Promise.resolve(makeResponse({ body: buildBlocklist() })),
    );
    configure({ matchSubdomains: false, dataset: { fetch: fetchMock, minDomains: 10 } });

    expect(await isDisposableDomain('mailinator.com')).toBe(true);
    expect(await isDisposableDomain('x.mailinator.com')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('status() does not create the default instance, so configure() still works afterwards', () => {
    expect(status().state).toBe('uninitialized');
    expect(() => configure({ matchSubdomains: false })).not.toThrow();
  });

  it('rejects configure() once the default instance is in use', async () => {
    stubGlobalFetch();
    await init();

    expect(() => configure({})).toThrow(ConfigError);
  });

  it('allows configure() again after close()', async () => {
    stubGlobalFetch();
    await init();
    await close();

    expect(() => configure({ matchSubdomains: false })).not.toThrow();
  });

  it('leaves the default instance unconfigured when configure() gets invalid options', () => {
    expect(() => configure({ matchSubdomains: 'yes' as unknown as boolean })).toThrow(ConfigError);
    expect(() => configure({})).not.toThrow();
  });

  it('starts fresh after close()', async () => {
    const fetchMock = stubGlobalFetch();
    await init();
    await close();
    await init();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('close() is safe when nothing was created', async () => {
    await expect(close()).resolves.toBeUndefined();
  });
});
