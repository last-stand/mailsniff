import { describe, expect, it } from 'vitest';
import { DomainMatcher } from '../../../src/domain/matcher';

function createMatcher(matchSubdomains = true): DomainMatcher {
  const matcher = new DomainMatcher(matchSubdomains);
  matcher.replaceCommunity(['mailinator.com', 'tempmail.test']);
  return matcher;
}

describe('DomainMatcher', () => {
  it('matches exact community domains', () => {
    expect(createMatcher().matches('mailinator.com')).toBe(true);
  });

  it('matches exact custom domains', () => {
    const matcher = createMatcher();
    matcher.addCustom(['mine.test']);

    expect(matcher.matches('mine.test')).toBe(true);
  });

  it('does not match unknown domains', () => {
    expect(createMatcher().matches('gmail.com')).toBe(false);
  });

  it('matches subdomains at any depth', () => {
    const matcher = createMatcher();

    expect(matcher.matches('a.mailinator.com')).toBe(true);
    expect(matcher.matches('x.y.z.mailinator.com')).toBe(true);
  });

  it('does not treat a longer name that merely ends with a listed one as a subdomain', () => {
    expect(createMatcher().matches('notmailinator.com')).toBe(false);
  });

  it('skips subdomain matching when disabled', () => {
    const matcher = createMatcher(false);

    expect(matcher.matches('a.mailinator.com')).toBe(false);
    expect(matcher.matches('mailinator.com')).toBe(true);
  });

  it('never matches a bare TLD entry', () => {
    const matcher = new DomainMatcher(true);
    matcher.replaceCommunity(['com']);

    expect(matcher.matches('example.com')).toBe(false);
  });

  it('replaces the community set wholesale', () => {
    const matcher = createMatcher();
    matcher.replaceCommunity(['other.test']);

    expect(matcher.matches('mailinator.com')).toBe(false);
    expect(matcher.matches('other.test')).toBe(true);
  });

  it('keeps custom domains when the community set is replaced', () => {
    const matcher = createMatcher();
    matcher.addCustom(['mine.test']);
    matcher.replaceCommunity([]);

    expect(matcher.matches('mine.test')).toBe(true);
    expect(matcher.hasCommunity).toBe(false);
  });

  it('adds, removes and replaces custom domains', () => {
    const matcher = createMatcher();
    matcher.addCustom(['a.test', 'b.test']);
    matcher.removeCustom(['a.test', 'unknown.test']);

    expect(matcher.matches('a.test')).toBe(false);
    expect(matcher.matches('b.test')).toBe(true);

    matcher.replaceCustom(['c.test']);

    expect(matcher.matches('b.test')).toBe(false);
    expect(matcher.customCount).toBe(1);
  });

  it('lists a sorted, de-duplicated union', () => {
    const matcher = createMatcher();
    matcher.addCustom(['zzz.test', 'mailinator.com']);

    expect(matcher.list()).toEqual(['mailinator.com', 'tempmail.test', 'zzz.test']);
  });

  it('reports counts', () => {
    const matcher = createMatcher();
    matcher.addCustom(['a.test']);

    expect(matcher.communityCount).toBe(2);
    expect(matcher.customCount).toBe(1);
    expect(matcher.hasCommunity).toBe(true);
  });
});
