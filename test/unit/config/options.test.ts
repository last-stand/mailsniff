import { describe, expect, it } from 'vitest';
import {
  MAX_REFRESH_INTERVAL_MS,
  MIN_REFRESH_INTERVAL_MS,
  parseInterval,
} from '../../../src/config/options';
import { ConfigError } from '../../../src/errors';
import type { Interval } from '../../../src/types';

describe('parseInterval', () => {
  it.each([
    ['1m', 60_000],
    ['30m', 1_800_000],
    ['12h', 43_200_000],
    ['1d', 86_400_000],
    ['7d', 604_800_000],
    ['24d', 2_073_600_000],
    [' 2H ', 7_200_000],
    [60_000, 60_000],
    [3_600_000, 3_600_000],
  ])('parses %j as %i ms', (input, expected) => {
    expect(parseInterval(input as Interval)).toBe(expected);
  });

  it.each([
    ['below the minimum (number)', 59_999],
    ['zero', 0],
    ['negative number', -1000],
    ['zero minutes', '0m'],
    ['above the maximum (string)', '25d'],
    ['above the maximum (number)', MAX_REFRESH_INTERVAL_MS + 1],
    ['Infinity', Infinity],
    ['NaN', NaN],
    ['empty string', ''],
    ['unsupported unit', '1s'],
    ['unit separated by a space', '1 d'],
    ['negative string', '-1h'],
    ['fractional string', '1.5h'],
    ['plain word', 'daily'],
    ['null', null],
    ['undefined', undefined],
    ['object', {}],
  ])('rejects %s', (_label, input) => {
    expect(() => parseInterval(input as unknown as Interval)).toThrow(ConfigError);
  });

  it('includes the option name in the error message', () => {
    expect(() => parseInterval('nope' as Interval, 'customOption')).toThrow(/customOption/);
  });

  it('keeps the maximum below the setTimeout overflow limit', () => {
    expect(MAX_REFRESH_INTERVAL_MS).toBeLessThan(2 ** 31 - 1);
    expect(MIN_REFRESH_INTERVAL_MS).toBe(60_000);
  });
});
