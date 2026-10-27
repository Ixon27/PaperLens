import { pageCites } from './cite';
import { anchorOf } from './explain';
import { findQuote, type QuoteBlock } from './quote-match';

export type CoverageBlock = QuoteBlock & { kind: 'body' | 'heading' | 'caption' | 'aside' };
export type Coverage = {
  sections: { idx: number; title: string; covered: boolean }[];
  covered: number;
  total: number;
  citations: number;
  located: number;
};

export function computeCoverage(blocks: CoverageBlock[], markdown: string): Coverage {
  const starts = blocks.flatMap((block, i) => anchorOf(blocks, i)?.type === 'section' ? [{ i, block }] : []);
  const sections = starts.map(({ block }) => ({ idx: block.idx, title: block.text.trim().slice(0, 40), covered: false }));
  const citations = pageCites(markdown);
  let located = 0;
  for (const cite of citations) {
    const hit = cite.quote ? findQuote(blocks, cite.page, cite.endPage, cite.quote) : null;
    if (hit) {
      located++;
      const at = blocks.findIndex((block) => block.idx === hit.idx);
      for (let s = 0; s < starts.length; s++) {
        if (at >= starts[s].i && at < (starts[s + 1]?.i ?? blocks.length)) sections[s].covered = true;
      }
    } else {
      for (let s = 0; s < starts.length; s++) {
        const end = starts[s + 1]?.i ?? blocks.length;
        if (blocks.slice(starts[s].i, end).some((block) => block.page >= cite.page && block.page <= (cite.endPage ?? cite.page))) {
          sections[s].covered = true;
        }
      }
    }
  }
  return { sections, covered: sections.filter((s) => s.covered).length, total: sections.length, citations: citations.length, located };
}
