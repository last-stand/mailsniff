import { describe, expect, it } from 'vitest';
import { chunk } from '../../../src/utils/chunk';

describe('chunk', () => {
  it('splits into batches of the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns a single batch when the size exceeds the length', () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
  });

  it('returns no batches for empty input', () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it.each([0, -1, 1.5, NaN])('rejects the invalid size %s', (size) => {
    expect(() => chunk([1], size)).toThrow(RangeError);
  });
});
