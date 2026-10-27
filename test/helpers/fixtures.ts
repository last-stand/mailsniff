export const SAMPLE_DOMAINS = ['mailinator.com', 'guerrillamail.com', 'tempmail.test'] as const;

export const FILLER_COUNT = 20;

export function generateDomains(count: number, suffix = 'filler.test'): string[] {
  return Array.from({ length: count }, (_unused, index) => `domain-${index}.${suffix}`);
}

/** Builds blocklist file content: the given domains plus generated filler. */
export function buildBlocklist(
  domains: readonly string[] = SAMPLE_DOMAINS,
  fillerCount = FILLER_COUNT,
): string {
  return `${[...domains, ...generateDomains(fillerCount)].join('\n')}\n`;
}
