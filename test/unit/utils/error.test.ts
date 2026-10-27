import { describe, expect, it } from 'vitest';
import { errorMessage, toError } from '../../../src/utils/error';

describe('error helpers', () => {
  it('toError keeps Error instances as they are', () => {
    const error = new TypeError('x');

    expect(toError(error)).toBe(error);
  });

  it('toError wraps other values', () => {
    expect(toError('oops')).toEqual(new Error('oops'));
    expect(toError(42).message).toBe('42');
  });

  it('errorMessage reads Error messages and stringifies the rest', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(null)).toBe('null');
  });
});
