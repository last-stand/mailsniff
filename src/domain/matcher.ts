/**
 * In-process lookup structure. Community and custom domains live in separate sets so
 * a community refresh can replace one without ever touching the other.
 */
export class DomainMatcher {
  private community: ReadonlySet<string> = new Set();
  private readonly custom = new Set<string>();
  private readonly matchSubdomains: boolean;

  constructor(matchSubdomains: boolean) {
    this.matchSubdomains = matchSubdomains;
  }

  get hasCommunity(): boolean {
    return this.community.size > 0;
  }

  get communityCount(): number {
    return this.community.size;
  }

  get customCount(): number {
    return this.custom.size;
  }

  /** Atomically swaps the community set (a single reference assignment). */
  replaceCommunity(domains: Iterable<string>): void {
    this.community = new Set(domains);
  }

  replaceCustom(domains: Iterable<string>): void {
    this.custom.clear();
    this.addCustom(domains);
  }

  addCustom(domains: Iterable<string>): void {
    for (const domain of domains) {
      this.custom.add(domain);
    }
  }

  removeCustom(domains: Iterable<string>): void {
    for (const domain of domains) {
      this.custom.delete(domain);
    }
  }

  /** @param domain an already normalized domain. */
  matches(domain: string): boolean {
    if (this.has(domain)) {
      return true;
    }
    if (!this.matchSubdomains) {
      return false;
    }

    let dot = domain.indexOf('.');
    while (dot !== -1) {
      const parent = domain.slice(dot + 1);
      // Never test a bare TLD such as "com".
      if (!parent.includes('.')) {
        return false;
      }
      if (this.has(parent)) {
        return true;
      }
      dot = domain.indexOf('.', dot + 1);
    }
    return false;
  }

  /** Sorted, de-duplicated union of community and custom domains. */
  list(): string[] {
    return [...new Set([...this.community, ...this.custom])].sort();
  }

  private has(domain: string): boolean {
    return this.community.has(domain) || this.custom.has(domain);
  }
}
