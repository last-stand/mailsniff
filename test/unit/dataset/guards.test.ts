import { describe, expect, it } from 'vitest';
import { assertNotShrunk } from '../../../src/dataset/guards';
import { DatasetError } from '../../../src/errors';

describe('assertNotShrunk', () => {
  it.each([
    ['equal size', 100, 100],
    ['growth', 100, 150],
    ['exactly at the default ratio', 100, 50],
    ['nothing served yet', 0, 3],
  ])('accepts %s', (_label, previous, next) => {
    expect(() => assertNotShrunk(previous, next)).not.toThrow();
  });

  it('rejects a drastic shrink and reports both sizes', () => {
    expect(() => assertNotShrunk(100, 49)).toThrow(DatasetError);
    expect(() => assertNotShrunk(100, 49)).toThrow(/from 100 to 49/);
  });

  it('honors a custom ratio', () => {
    expect(() => assertNotShrunk(100, 80, 0.9)).toThrow(DatasetError);
    expect(() => assertNotShrunk(100, 90, 0.9)).not.toThrow();
  });
});
