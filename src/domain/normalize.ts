import { domainToASCII } from 'node:url';
import { ValidationError } from '../errors';

const MAX_DOMAIN_LENGTH = 253;
const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;
const MAX_REPORTED_INVALID = 5;

const ASCII_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NUMERIC_LABEL = /^\d+$/;
/**
 * Letters, marks, digits, dots and hyphens only. `domainToASCII` runs a URL host parser
 * that would silently accept `a/b` or `user@host`, so separators are rejected up front.
 */
const DOMAIN_CHARACTERS = /^[\p{L}\p{M}\p{N}.-]+$/u;
const NON_ASCII = /[^\u0020-\u007E]/;

function isValidAsciiDomain(domain: string): boolean {
  if (domain.length === 0 || domain.length > MAX_DOMAIN_LENGTH) {
    return false;
  }

  const labels = domain.split('.');
  const topLevel = labels[labels.length - 1] ?? '';

  return (
    labels.length >= 2 &&
    labels.every((label) => ASCII_LABEL.test(label)) &&
    // Rejects IPv4 addresses such as 127.0.0.1.
    !NUMERIC_LABEL.test(topLevel)
  );
}

/**
 * Normalizes a domain: trims, lowercases, drops one trailing dot and converts
 * internationalized names to punycode.
 * @returns the normalized domain, or `null` when the input is not a valid hostname.
 */
export function normalizeDomain(input: string): string | null {
  let domain = input.trim().toLowerCase();
  if (domain.endsWith('.')) {
    domain = domain.slice(0, -1);
  }

  if (domain.length === 0 || domain.length > MAX_DOMAIN_LENGTH || !DOMAIN_CHARACTERS.test(domain)) {
    return null;
  }

  if (NON_ASCII.test(domain)) {
    domain = domainToASCII(domain);
  }

  return isValidAsciiDomain(domain) ? domain : null;
}

/**
 * Extracts the normalized domain of an email address. The check is deliberately
 * lightweight (not full RFC 5322): the local part is only length- and whitespace-checked.
 * @returns the normalized domain, or `null` when the input is not a plausible email.
 */
export function extractEmailDomain(email: string): string | null {
  const value = email.trim();
  if (value.length === 0 || value.length > MAX_EMAIL_LENGTH || /\s/.test(value)) {
    return null;
  }

  // Split on the last "@" because quoted local parts may contain one.
  const separator = value.lastIndexOf('@');
  if (separator < 1 || separator > MAX_LOCAL_PART_LENGTH) {
    return null;
  }

  return normalizeDomain(value.slice(separator + 1));
}

/**
 * Normalizes and de-duplicates a list of domains. All-or-nothing: if any entry is
 * invalid, nothing is returned and every invalid entry is reported.
 * @throws {ValidationError}
 */
export function normalizeDomains(inputs: readonly unknown[]): string[] {
  const valid = new Set<string>();
  const invalid: string[] = [];

  for (const input of inputs) {
    const normalized = typeof input === 'string' ? normalizeDomain(input) : null;
    if (normalized === null) {
      invalid.push(String(input));
    } else {
      valid.add(normalized);
    }
  }

  if (invalid.length > 0) {
    const preview = invalid
      .slice(0, MAX_REPORTED_INVALID)
      .map((entry) => JSON.stringify(entry))
      .join(', ');
    const more =
      invalid.length > MAX_REPORTED_INVALID
        ? ` (and ${invalid.length - MAX_REPORTED_INVALID} more)`
        : '';
    throw new ValidationError(`Invalid domain(s): ${preview}${more}`, invalid);
  }

  return [...valid];
}
