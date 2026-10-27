import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../../src/errors';
import {
  extractEmailDomain,
  normalizeDomain,
  normalizeDomains,
} from '../../../src/domain/normalize';

describe('normalizeDomain', () => {
  it.each([
    ['example.com', 'example.com'],
    [' Example.COM ', 'example.com'],
    ['example.com.', 'example.com'],
    ['a.b.example.co.uk', 'a.b.example.co.uk'],
    ['1a.io', '1a.io'],
    ['my-site.example', 'my-site.example'],
    ['münchen.de', 'xn--mnchen-3ya.de'],
    ['xn--mnchen-3ya.de', 'xn--mnchen-3ya.de'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it('converts other internationalized names to punycode', () => {
    const result = normalizeDomain('例え.jp');

    expect(result).toMatch(/^xn--.+\.jp$/);
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['single label', 'localhost'],
    ['leading dot', '.com'],
    ['double dot', 'example..com'],
    ['trailing double dot', 'example.com..'],
    ['leading hyphen', '-bad.com'],
    ['trailing hyphen', 'bad-.com'],
    ['inner whitespace', 'exa mple.com'],
    ['email address', 'user@example.com'],
    ['path', 'example.com/path'],
    ['port', 'example.com:8080'],
    ['URL', 'http://example.com'],
    ['wildcard', '*.example.com'],
    ['IPv4 address', '127.0.0.1'],
    ['underscore', 'ex_ample.com'],
    ['label over 63 characters', `${'a'.repeat(64)}.com`],
    ['name over 253 characters', `${'a'.repeat(60)}.`.repeat(5) + 'com'],
  ])('rejects %s', (_label, input) => {
    expect(normalizeDomain(input)).toBeNull();
  });
});

describe('extractEmailDomain', () => {
  it.each([
    ['user@mailinator.com', 'mailinator.com'],
    [' User@Mailinator.COM ', 'mailinator.com'],
    ['a+tag@sub.example.com', 'sub.example.com'],
    ['"john@doe"@example.com', 'example.com'],
    ['user@münchen.de', 'xn--mnchen-3ya.de'],
    [`${'a'.repeat(64)}@example.com`, 'example.com'],
  ])('extracts the domain of %j', (input, expected) => {
    expect(extractEmailDomain(input)).toBe(expected);
  });

  it.each([
    ['empty string', ''],
    ['no @', 'plain'],
    ['empty local part', '@example.com'],
    ['empty domain', 'user@'],
    ['single-label domain', 'user@localhost'],
    ['whitespace in local part', 'us er@example.com'],
    ['whitespace in domain', 'user@exa mple.com'],
    ['local part over 64 characters', `${'a'.repeat(65)}@example.com`],
    ['address over 254 characters', `${'a'.repeat(250)}@example.com`],
    ['dangling separators', 'user@@'],
  ])('rejects %s', (_label, input) => {
    expect(extractEmailDomain(input)).toBeNull();
  });
});

describe('normalizeDomains', () => {
  it('normalizes and de-duplicates', () => {
    expect(normalizeDomains(['Example.com', 'example.com', ' b.org '])).toEqual([
      'example.com',
      'b.org',
    ]);
  });

  it('returns an empty list for empty input', () => {
    expect(normalizeDomains([])).toEqual([]);
  });

  it('is all-or-nothing and reports every invalid entry', () => {
    let caught: unknown;
    try {
      normalizeDomains(['good.com', 'bad', 'also bad', 42]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).invalid).toEqual(['bad', 'also bad', '42']);
    expect((caught as ValidationError).message).toContain('"bad"');
  });

  it('truncates the message for long lists but keeps every entry in `invalid`', () => {
    const entries = Array.from({ length: 8 }, (_unused, index) => `bad${index}`);
    let caught: unknown;
    try {
      normalizeDomains(entries);
    } catch (error) {
      caught = error;
    }

    expect((caught as ValidationError).invalid).toHaveLength(8);
    expect((caught as ValidationError).message).toContain('and 3 more');
  });
});
