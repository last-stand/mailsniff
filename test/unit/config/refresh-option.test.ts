import { describe, expect, it } from 'vitest';
import { resolveOptions } from '../../../src/config/options';
import { ConfigError } from '../../../src/errors';
import type { MailSniffOptions } from '../../../src/types';

describe('resolveOptions: refreshInterval', () => {
  it('is disabled by default', () => {
    expect(resolveOptions().refreshIntervalMs).toBeUndefined();
  });

  it.each([
    ['1d', 86_400_000],
    ['30m', 1_800_000],
    [3_600_000, 3_600_000],
  ])('converts %j to %i ms', (value, expected) => {
    const options = { refreshInterval: value } as MailSniffOptions;

    expect(resolveOptions(options).refreshIntervalMs).toBe(expected);
  });

  it.each(['nope', '25d', '0m', 1000, null])('rejects %j', (value) => {
    const options = { refreshInterval: value } as unknown as MailSniffOptions;

    expect(() => resolveOptions(options)).toThrow(ConfigError);
  });
});
