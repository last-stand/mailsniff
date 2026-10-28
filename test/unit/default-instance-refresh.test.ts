import { afterEach, describe, expect, it, vi } from 'vitest';
import { close, configure, init, refresh, status } from '../../src/default-instance';
import type { FetchLike } from '../../src/dataset/fetcher';
import { makeResponse } from '../helpers/fake-fetch';
import { buildBlocklist } from '../helpers/fixtures';

function createFetch() {
  return vi.fn<FetchLike>(() => Promise.resolve(makeResponse({ body: buildBlocklist() })));
}

describe('default instance: refresh', () => {
  afterEach(async () => {
    await close();
  });

  it('refresh() forces a new download', async () => {
    const fetch = createFetch();
    configure({ dataset: { fetch, minDomains: 10 } });
    await init();
    const result = await refresh();

    expect(result.status).toBe('updated');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('configure() accepts a refreshInterval, and close() stops the schedule', async () => {
    configure({ refreshInterval: '1d', dataset: { fetch: createFetch(), minDomains: 10 } });
    await init();

    expect(status().autoRefresh).toBe(true);
    expect(status().nextRefreshAt).not.toBeNull();

    await close();
    expect(status().autoRefresh).toBe(false); // a fresh, unconfigured default instance
  });
});
