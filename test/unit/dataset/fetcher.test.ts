import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDataset } from '../../../src/dataset/fetcher';
import type { FetchLike, ResponseLike } from '../../../src/dataset/fetcher';
import { DatasetError } from '../../../src/errors';
import { makeResponse } from '../../helpers/fake-fetch';

const base = { url: 'https://example.test/list.conf', timeoutMs: 1000, maxBytes: 1024 };

function fetchReturning(...args: Parameters<typeof makeResponse>) {
  return vi.fn<FetchLike>(() => Promise.resolve(makeResponse(...args)));
}

describe('fetchDataset', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the body and the etag', async () => {
    const fetch = fetchReturning({ body: 'a.com\n', headers: { ETag: '"abc"' } });

    await expect(fetchDataset({ ...base, fetch })).resolves.toEqual({
      status: 'modified',
      body: 'a.com\n',
      etag: '"abc"',
    });
  });

  it('returns an undefined etag when the server sends none', async () => {
    const result = await fetchDataset({ ...base, fetch: fetchReturning({ body: 'a.com' }) });

    expect(result).toEqual({ status: 'modified', body: 'a.com' });
  });

  it('sends identifying headers and the abort signal, without If-None-Match', async () => {
    const fetch = fetchReturning({ body: 'a.com' });
    await fetchDataset({ ...base, fetch });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(base.url);
    expect(init.headers['accept']).toBe('text/plain');
    expect(init.headers['user-agent']).toContain('mailsniff');
    expect(init.headers['if-none-match']).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends If-None-Match when an etag is known', async () => {
    const fetch = fetchReturning({ body: 'a.com' });
    await fetchDataset({ ...base, fetch, etag: '"abc"' });

    expect(fetch.mock.calls[0]![1].headers['if-none-match']).toBe('"abc"');
  });

  it('resolves not-modified for a 304 to a conditional request', async () => {
    const fetch = fetchReturning({ status: 304 });

    await expect(fetchDataset({ ...base, fetch, etag: '"abc"' })).resolves.toEqual({
      status: 'not-modified',
    });
  });

  it('rejects a 304 to an unconditional request', async () => {
    const fetch = fetchReturning({ status: 304 });

    await expect(fetchDataset({ ...base, fetch })).rejects.toThrow(DatasetError);
  });

  it('rejects non-2xx responses', async () => {
    const fetch = fetchReturning({ status: 500 });

    await expect(fetchDataset({ ...base, fetch })).rejects.toThrow(/HTTP 500/);
  });

  it('wraps network errors and keeps the cause', async () => {
    const cause = new Error('ECONNRESET');
    const fetch = vi.fn<FetchLike>(() => Promise.reject(cause));

    const error: unknown = await fetchDataset({ ...base, fetch }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DatasetError);
    expect((error as DatasetError).cause).toBe(cause);
    expect((error as DatasetError).message).toContain('ECONNRESET');
  });

  it('times out and aborts the request', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<FetchLike>(
      (_url, init) =>
        new Promise<ResponseLike>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );

    const assertion = expect(fetchDataset({ ...base, fetch })).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(base.timeoutMs);

    await assertion;
  });

  it('clears its timer after a successful download', async () => {
    vi.useFakeTimers();
    await fetchDataset({ ...base, fetch: fetchReturning({ body: 'a.com' }) });

    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects when content-length exceeds the limit', async () => {
    const fetch = fetchReturning({ body: 'a.com', headers: { 'content-length': '999999' } });

    await expect(fetchDataset({ ...base, fetch })).rejects.toThrow(/too large/);
  });

  it('stops reading and cancels the stream once the limit is exceeded', async () => {
    const response = makeResponse({ body: 'x'.repeat(100), chunkSize: 10 });
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(response));

    await expect(fetchDataset({ ...base, maxBytes: 50, fetch })).rejects.toThrow(/too large/);
    expect(response.state.cancelled).toBe(true);
  });

  it('enforces the limit for responses without a stream', async () => {
    const tooBig = fetchReturning({ body: 'x'.repeat(100), noStream: true });
    const fine = fetchReturning({ body: 'a.com', noStream: true });

    await expect(fetchDataset({ ...base, maxBytes: 50, fetch: tooBig })).rejects.toThrow(
      /too large/,
    );
    await expect(fetchDataset({ ...base, maxBytes: 50, fetch: fine })).resolves.toMatchObject({
      body: 'a.com',
    });
  });

  it('decodes multi-chunk UTF-8 bodies', async () => {
    const fetch = fetchReturning({ body: 'münchen.de\n', chunkSize: 3 });

    await expect(fetchDataset({ ...base, fetch })).resolves.toMatchObject({ body: 'münchen.de\n' });
  });

  it('uses the global fetch when none is injected', async () => {
    const globalFetch = fetchReturning({ body: 'a.com' });
    vi.stubGlobal('fetch', globalFetch);

    await fetchDataset(base);

    expect(globalFetch).toHaveBeenCalledTimes(1);
  });

  it('fails clearly when no fetch implementation exists', async () => {
    vi.stubGlobal('fetch', undefined);

    await expect(fetchDataset(base)).rejects.toThrow(/No fetch implementation/);
  });
});
