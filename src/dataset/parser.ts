import { DEFAULT_MAX_INVALID_RATIO, DEFAULT_MIN_DOMAINS } from '../constants';
import { normalizeDomain } from '../domain/normalize';
import { DatasetError } from '../errors';

export interface ParseOptions {
  /** Minimum number of valid domains for the dataset to be accepted. */
  readonly minDomains?: number;
  /** Maximum share (0 to 1) of non-comment lines that may be invalid. */
  readonly maxInvalidRatio?: number;
}

function stripComment(line: string): string {
  const hash = line.indexOf('#');
  return hash === -1 ? line : line.slice(0, hash);
}

/**
 * Parses a one-domain-per-line blocklist into a sorted, de-duplicated list of
 * normalized domains. A few bad lines are skipped, but a dataset that is mostly invalid
 * (for example an HTML error page) or suspiciously small is rejected as a whole.
 * @throws {DatasetError}
 */
export function parseBlocklist(text: string, options: ParseOptions = {}): string[] {
  const minDomains = options.minDomains ?? DEFAULT_MIN_DOMAINS;
  const maxInvalidRatio = options.maxInvalidRatio ?? DEFAULT_MAX_INVALID_RATIO;

  const domains = new Set<string>();
  let considered = 0;
  let invalid = 0;

  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line.length === 0) {
      continue;
    }

    considered += 1;
    const domain = normalizeDomain(line);
    if (domain === null) {
      invalid += 1;
    } else {
      domains.add(domain);
    }
  }

  if (considered === 0) {
    throw new DatasetError('The dataset contains no domains');
  }
  if (invalid / considered > maxInvalidRatio) {
    throw new DatasetError(
      `The dataset was rejected: ${invalid} of ${considered} lines are not valid domains`,
    );
  }
  if (domains.size < minDomains) {
    throw new DatasetError(
      `The dataset was rejected: it has ${domains.size} domains, expected at least ${minDomains}`,
    );
  }

  return [...domains].sort();
}
