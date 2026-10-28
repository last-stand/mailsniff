import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../../src/dataset/fetcher';
import { MailSniff } from '../../src/mailsniff';
import { makeResponse } from '../helpers/fake-fetch';
import { buildBlocklist } from '../helpers/fixtures';

const REDIS_URL = process.env['REDIS_URL'];

// Runs against a real Redis (CI provides one). Skipped locally unless REDIS_URL is set.
describe.skipIf(!REDIS_URL)('Redis refresh coordination (real Redis)', () => {
  function createInstances(keyPrefix: string, fetch: FetchLike, count: number): MailSniff[] {
    return Array.from(
      { length: count },
      () =>
        new MailSniff({
          redis: { url: REDIS_URL, keyPrefix },
          dataset: { fetch, minDomains: 10 },
        }),
    );
  }

  it('lets one instance download while the others wait for and adopt its list', async () => {
    const fetch = vi.fn<FetchLike>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return makeResponse({ body: buildBlocklist() });
    });
    const instances = createInstances(`mailsniff-test:${randomUUID()}:startup`, fetch, 3);
    await Promise.all(instances.map((instance) => instance.init()));

    expect(fetch).toHaveBeenCalledTimes(1);
    for (const instance of instances) {
      expect(instance.status().state).toBe('ready');
      expect(await instance.isDisposableDomain('mailinator.com')).toBe(true);
    }

    await instances[0]!.clearCache({ includeCustom: true });
    await Promise.all(instances.map((instance) => instance.close()));
  });

  it('downloads once when several instances refresh at the same time', async () => {
    const fetch = vi.fn<FetchLike>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return makeResponse({ body: buildBlocklist() });
    });
    const instances = createInstances(`mailsniff-test:${randomUUID()}:refresh`, fetch, 3);
    await Promise.all(instances.map((instance) => instance.init()));
    fetch.mockClear();

    const results = await Promise.all(instances.map((instance) => instance.refresh()));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.status === 'updated')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'synced')).toHaveLength(2);

    await instances[0]!.clearCache({ includeCustom: true });
    await Promise.all(instances.map((instance) => instance.close()));
  });
});
