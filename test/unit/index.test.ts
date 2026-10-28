import { describe, expect, it, vi } from 'vitest';
import * as api from '../../src/index';
import type { FetchLike } from '../../src/dataset/fetcher';
import { makeResponse } from '../helpers/fake-fetch';
import { buildBlocklist } from '../helpers/fixtures';

const EXPECTED_EXPORTS = [
  'CacheError',
  'ClosedError',
  'ConfigError',
  'DatasetError',
  'MailSniff',
  'MailSniffError',
  'ValidationError',
  'addDisposableDomains',
  'clearCache',
  'close',
  'configure',
  'createMailSniff',
  'init',
  'isDisposableDomain',
  'isDisposableEmail',
  'listDisposableDomains',
  'refresh',
  'removeDisposableDomains',
  'status',
];

describe('public entry point', () => {
  // Locks the public surface: adding or removing an export must be a deliberate change.
  it('exposes exactly the documented runtime exports', () => {
    expect(Object.keys(api).sort()).toEqual([...EXPECTED_EXPORTS].sort());
  });

  it('exports usable error classes', () => {
    const error = new api.ValidationError('bad input', ['x']);

    expect(error).toBeInstanceOf(api.MailSniffError);
    expect(error.invalid).toEqual(['x']);
  });

  it('createMailSniff returns independent, working instances', async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(makeResponse({ body: buildBlocklist() })));
    const first = api.createMailSniff({ dataset: { fetch, minDomains: 10 } });
    const second = api.createMailSniff({ dataset: { fetch, minDomains: 10 } });
    await first.addDisposableDomains(['only-first.test']);

    expect(first).toBeInstanceOf(api.MailSniff);
    expect(await first.isDisposableDomain('only-first.test')).toBe(true);
    expect(await second.isDisposableDomain('only-first.test')).toBe(false);
  });
});
