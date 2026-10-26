import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBboxLayout } from '../src/server/pdf/extract';

const xhtml = readFileSync(join(import.meta.dirname, 'fixtures/bbox-sample.html'), 'utf8');
const { pageCount, blocks } = parseBboxLayout(xhtml);
const byText = (prefix: string) => blocks.find((b) => b.text.startsWith(prefix))!;

describe('parseBboxLayout', () => {
  it('counts pages and drops empty blocks, numbering the rest in reading order', () => {
    expect(pageCount).toBe(2);
    expect(blocks.map((b) => b.idx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(blocks.map((b) => b.page)).toEqual([1, 1, 2, 2, 2, 2, 2, 2]);
  });

  it('repairs line-break hyphenation and decodes entities', () => {
    expect(byText('The gut').text).toBe('The gut microbiome of Gram-Negative bacteria & IL-6 levels.');
    expect(byText('2.').text).toBe('2. Lee K. Microbiome "dark matter" <review>.');
  });

  it('marks only blocks after the LAST references heading, stopping at back matter', () => {
    const flagged = blocks.filter((b) => b.isRef).map((b) => b.text);
    expect(flagged).toEqual(['1. Smith J. Gut bacteria. Nature 2020.', '2. Lee K. Microbiome "dark matter" <review>.']);
    expect(byText('References').isRef).toBe(false);
    expect(byText('Table S1').isRef).toBe(false);
  });

  it('keeps page size and per-line boxes in PDF points', () => {
    const b = byText('The gut');
    expect([b.pageW, b.pageH]).toEqual([612, 792]);
    expect(b.lines).toHaveLength(4);
    expect(b.lines[0]).toEqual([72, 100, 290.5, 112.25]);
    expect([byText('Methods').pageW, byText('Methods').pageH]).toEqual([595.28, 841.89]);
  });
});
