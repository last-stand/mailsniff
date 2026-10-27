import { describe, expect, it } from 'vitest';
import { parseBlocklist } from '../../../src/dataset/parser';
import { DatasetError } from '../../../src/errors';
import { generateDomains } from '../../helpers/fixtures';

describe('parseBlocklist', () => {
  it('normalizes, de-duplicates and sorts', () => {
    expect(parseBlocklist('B.com\n a.com \nb.com\n', { minDomains: 1 })).toEqual([
      'a.com',
      'b.com',
    ]);
  });

  it('skips blank lines and comments', () => {
    const text = '# header\n\na.com # trailing note\n   \nb.com\n';

    expect(parseBlocklist(text, { minDomains: 1 })).toEqual(['a.com', 'b.com']);
  });

  it('handles CRLF line endings and a leading BOM', () => {
    expect(parseBlocklist('\uFEFFa.com\r\nb.com\r\n', { minDomains: 1 })).toEqual([
      'a.com',
      'b.com',
    ]);
  });

  it('tolerates a small share of invalid lines', () => {
    const text = [...generateDomains(200), 'not a domain'].join('\n');

    expect(parseBlocklist(text, { minDomains: 100 })).toHaveLength(200);
  });

  it('rejects an HTML error page', () => {
    const html = '<html>\n<body>Not found</body>\n</html>';

    expect(() => parseBlocklist(html, { minDomains: 1 })).toThrow(DatasetError);
    expect(() => parseBlocklist(html, { minDomains: 1 })).toThrow(/not valid domains/);
  });

  it('rejects a dataset with too few domains (default minimum)', () => {
    expect(() => parseBlocklist(generateDomains(5).join('\n'))).toThrow(/at least 500/);
  });

  it('honors a custom minimum', () => {
    const text = generateDomains(5).join('\n');

    expect(parseBlocklist(text, { minDomains: 5 })).toHaveLength(5);
    expect(() => parseBlocklist(text, { minDomains: 6 })).toThrow(DatasetError);
  });

  it('honors a custom invalid-line ratio', () => {
    const text = ['a.com', 'b.com', 'c.com', 'bad line'].join('\n');

    expect(() => parseBlocklist(text, { minDomains: 1 })).toThrow(DatasetError);
    expect(parseBlocklist(text, { minDomains: 1, maxInvalidRatio: 0.5 })).toHaveLength(3);
  });

  it.each([
    ['empty text', ''],
    ['only whitespace', '  \n\n'],
    ['only comments', '# nothing here\n# at all'],
  ])('rejects %s', (_label, text) => {
    expect(() => parseBlocklist(text, { minDomains: 1 })).toThrow(/no domains/);
  });
});
