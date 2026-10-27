import { describe, expect, it } from 'vitest';
import { resolveRedisConstructor } from '../../../src/cache/redis-client';

class Fake {}

describe('resolveRedisConstructor', () => {
  it.each([
    ['the class itself', Fake],
    ['a named export', { Redis: Fake }],
    ['a default export', { default: Fake }],
    ['a nested default.Redis', { default: { Redis: Fake } }],
  ])('finds the class in %s', (_label, moduleExports) => {
    expect(resolveRedisConstructor(moduleExports)).toBe(Fake);
  });

  it('finds a Redis property attached to a default-exported class', () => {
    const Default = Object.assign(function Default() {}, { Redis: Fake });

    expect(resolveRedisConstructor({ default: Default })).toBe(Default);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'ioredis'],
    ['an empty object', {}],
    ['a non-class default', { default: 'nope' }],
  ])('returns null for %s', (_label, moduleExports) => {
    expect(resolveRedisConstructor(moduleExports)).toBeNull();
  });
});
