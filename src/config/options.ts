import { ConfigError } from '../errors';
import type { Interval } from '../types';

type IntervalUnit = 'm' | 'h' | 'd';

const MS_PER_UNIT: Record<IntervalUnit, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Refreshing more often than this would hammer the source for no benefit. */
export const MIN_REFRESH_INTERVAL_MS = MS_PER_UNIT.m;

/**
 * `setTimeout` overflows above 2^31-1 ms (~24.8 days) and fires immediately,
 * which would turn a long interval into a busy loop. 24 days stays safely below it.
 */
export const MAX_REFRESH_INTERVAL_MS = 24 * MS_PER_UNIT.d;

const INTERVAL_PATTERN = /^(\d+)(m|h|d)$/;

function toMilliseconds(value: unknown, optionName: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const match = INTERVAL_PATTERN.exec(value.trim().toLowerCase());
    if (match) {
      const [, amount = '', unit = ''] = match;
      return Number(amount) * MS_PER_UNIT[unit as IntervalUnit];
    }
  }

  throw new ConfigError(
    `${optionName} must be a number of milliseconds or a string like "30m", "12h" or "1d" (got ${String(value)})`,
  );
}

/**
 * Converts an {@link Interval} to milliseconds and enforces the supported range.
 * @throws {ConfigError} when the value is malformed or outside 1 minute – 24 days.
 */
export function parseInterval(value: Interval, optionName = 'refreshInterval'): number {
  const ms = toMilliseconds(value, optionName);

  if (ms < MIN_REFRESH_INTERVAL_MS || ms > MAX_REFRESH_INTERVAL_MS) {
    throw new ConfigError(`${optionName} must be between 1m and 24d (got ${String(value)})`);
  }

  return ms;
}
