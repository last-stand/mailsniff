import { describe, expect, it } from 'vitest';
import {
  CacheError,
  ClosedError,
  ConfigError,
  DatasetError,
  MailSniffError,
  ValidationError,
} from '../../src/errors';
import type { MailSniffErrorCode } from '../../src/errors';

type ErrorCase = readonly [
  name: string,
  create: (message: string) => MailSniffError,
  code: MailSniffErrorCode,
];

const cases: readonly ErrorCase[] = [
  ['ConfigError', (m) => new ConfigError(m), 'CONFIG_ERROR'],
  ['ValidationError', (m) => new ValidationError(m), 'VALIDATION_ERROR'],
  ['DatasetError', (m) => new DatasetError(m), 'DATASET_ERROR'],
  ['CacheError', (m) => new CacheError(m), 'CACHE_ERROR'],
  ['ClosedError', (m) => new ClosedError(m), 'CLOSED_ERROR'],
];

describe('error hierarchy', () => {
  it.each(cases)('%s has the expected name, code and message', (name, create, code) => {
    const error = create('something failed');

    expect(error.name).toBe(name);
    expect(error.code).toBe(code);
    expect(error.message).toBe('something failed');
  });

  it.each(cases)('%s extends MailSniffError and Error', (_name, create) => {
    const error = create('x');

    expect(error).toBeInstanceOf(MailSniffError);
    expect(error).toBeInstanceOf(Error);
  });

  it('preserves the original cause', () => {
    const cause = new Error('boom');

    expect(new ConfigError('x', { cause }).cause).toBe(cause);
    expect(new ValidationError('x', [], { cause }).cause).toBe(cause);
    expect(new DatasetError('x', { cause }).cause).toBe(cause);
    expect(new CacheError('x', { cause }).cause).toBe(cause);
    expect(new ClosedError('x', { cause }).cause).toBe(cause);
  });

  it('base class accepts an explicit code', () => {
    const error = new MailSniffError('x', 'CACHE_ERROR');

    expect(error.name).toBe('MailSniffError');
    expect(error.code).toBe('CACHE_ERROR');
  });
});

describe('ValidationError', () => {
  it('defaults to an empty invalid list', () => {
    expect(new ValidationError('x').invalid).toEqual([]);
  });

  it('exposes the rejected entries', () => {
    expect(new ValidationError('x', ['a', 'b']).invalid).toEqual(['a', 'b']);
  });

  it('stores a frozen copy so later mutation of the input has no effect', () => {
    const source = ['a'];
    const error = new ValidationError('x', source);
    source.push('b');

    expect(error.invalid).toEqual(['a']);
    expect(Object.isFrozen(error.invalid)).toBe(true);
  });
});
