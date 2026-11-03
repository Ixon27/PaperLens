import { describe, expect, it } from 'vitest';
import pages from './fixtures/lnp-layout.json';
import { layoutDocument, type PageText } from '../src/server/pdf/layout';

// Genuine PDF.js text items from pp. 1–3 of DOI 10.1038/s41587-025-02556-5,
// publicly hosted by UPenn. Includes word-fragmented columns and Fig. 1's two-column legend.
const source = pages as unknown as PageText[];

describe('LNP paper source reading order', () => {
  it('keeps word-fragmented left and right body columns separate and maps their actual items', () => {
    const blocks = layoutDocument(source);
    const left = blocks.find((b) => b.text.startsWith('The success of the coronavirus'))!;
    const right = blocks.find((b) => b.text.startsWith('half-life (~hours)'))!;
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    expect(left.idx).toBeLessThan(right.idx);
    expect(left.text).toContain('vaccines showed the unprecedented power of lipid nanoparticles');
    expect(left.text).not.toContain('half-life (~hours)');
    expect(right.text).not.toContain('the unprecedented power');
    for (const [page, item] of left.spans) {
      const items = source[page - 1].content.items.filter((run) => 'str' in run && run.str !== '');
      const run = items[item];
      expect('str' in run && run.transform[4] < 300).toBe(true);
    }
    for (const [page, item] of right.spans) {
      // The paragraph continues on p.3's left column after the full-page figure on p.2.
      if (page !== 1) continue;
      const items = source[page - 1].content.items.filter((run) => 'str' in run && run.str !== '');
      const run = items[item];
      expect('str' in run && run.transform[4] > 300).toBe(true);
    }
  });

  it('includes the entire right-column caption through its statistical-significance ending', () => {
    const blocks = layoutDocument(source);
    const legends = blocks.filter((b) => b.page === 2 && b.kind === 'caption');
    expect(legends[0].text).toMatch(/^Fig\. 1 \| Unlike nucleoside-modified mRNA-LNP/);
    const text = legends.map((b) => b.text).join(' ');
    expect(text).toContain('injected in mice, and plasma was collected 4 h later');
    expect(text).toContain('RAW264.7. i, Effect of 1,000 ng ml');
    expect(text).toMatch(/NS, not significant\.$/);
    expect(legends.every((b) => b.spans.length > 0)).toBe(true);
    expect(blocks.find((b) => b.page === 2 && b.text === 'Nature Biotechnology')?.kind).toBe('aside');
  });
});
