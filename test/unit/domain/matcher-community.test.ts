import { describe, expect, it } from 'vitest';
import { DomainMatcher } from '../../../src/domain/matcher';

describe('DomainMatcher.listCommunity', () => {
  it('returns only community domains', () => {
    const matcher = new DomainMatcher(true);
    matcher.replaceCommunity(['a.test', 'b.test']);
    matcher.addCustom(['mine.test']);

    expect(matcher.listCommunity().sort()).toEqual(['a.test', 'b.test']);
  });

  it('returns a copy that cannot alter the matcher', () => {
    const matcher = new DomainMatcher(true);
    matcher.replaceCommunity(['a.test']);
    matcher.listCommunity().push('injected.test');

    expect(matcher.matches('injected.test')).toBe(false);
  });
});
