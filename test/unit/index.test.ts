import { describe, expect, it } from 'vitest';
import * as api from '../../src/index';

describe('public entry point', () => {
  // Locks the public surface: adding or removing an export must be a deliberate change.
  it('exposes exactly the documented runtime exports', () => {
    expect(Object.keys(api).sort()).toEqual([
      'CacheError',
      'ConfigError',
      'DatasetError',
      'MailSniffError',
      'ValidationError',
    ]);
  });

  it('exports usable error classes', () => {
    const error = new api.ValidationError('bad input', ['x']);

    expect(error).toBeInstanceOf(api.MailSniffError);
    expect(error.invalid).toEqual(['x']);
  });
});
