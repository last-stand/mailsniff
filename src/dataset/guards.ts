import { DEFAULT_MIN_SHRINK_RATIO } from '../constants';
import { DatasetError } from '../errors';

/**
 * Rejects a download that is drastically smaller than the list being served (a truncated
 * or tampered file). Skipped when nothing is being served yet.
 * @throws {DatasetError}
 */
export function assertNotShrunk(
  previousCount: number,
  nextCount: number,
  minRatio: number = DEFAULT_MIN_SHRINK_RATIO,
): void {
  if (previousCount > 0 && nextCount < previousCount * minRatio) {
    throw new DatasetError(
      `The dataset was rejected: it shrank from ${previousCount} to ${nextCount} domains`,
    );
  }
}
