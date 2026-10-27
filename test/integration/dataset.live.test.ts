import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_DATASET_BYTES,
  DEFAULT_MIN_DOMAINS,
  DEFAULT_SOURCE_URL,
} from '../../src/constants';
import { fetchDataset } from '../../src/dataset/fetcher';
import { parseBlocklist } from '../../src/dataset/parser';

// Hits GitHub, so it is opt-in: MAILSNIFF_LIVE=1 pnpm test:integration
describe.skipIf(process.env['MAILSNIFF_LIVE'] !== '1')('live dataset', () => {
  it('downloads and parses the real community blocklist', async () => {
    const result = await fetchDataset({
      url: DEFAULT_SOURCE_URL,
      timeoutMs: 15_000,
      maxBytes: DEFAULT_MAX_DATASET_BYTES,
    });

    expect(result.status).toBe('modified');
    if (result.status !== 'modified') {
      return;
    }

    const domains = parseBlocklist(result.body, { minDomains: DEFAULT_MIN_DOMAINS });

    expect(domains.length).toBeGreaterThan(DEFAULT_MIN_DOMAINS);
    expect(domains).toContain('mailinator.com');
  });
});
