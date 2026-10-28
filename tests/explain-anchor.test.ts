import { describe, expect, it } from 'vitest';
import { layoutDocument, type PageText } from '../src/server/pdf/layout';
import { anchorId, anchorOf, captionKindName, captionLabel, findAnchor, mentionPattern, parseAnchor, sectionBody } from '../src/shared/explain';
import { a4Viewport, journalPages } from './fixtures/pdf-text';

const journal = layoutDocument(journalPages.map((content): PageText => ({ viewport: a4Viewport, content })));
const at = (prefix: string) => journal.findIndex((block) => block.text.startsWith(prefix));

describe('explanation anchors', () => {
  it('anchors a table caption by its label', () => {
    const i = at('Table 1.');
    expect(anchorOf(journal, i)).toMatchObject({ type: 'table', page: journal[i].page });
    expect(captionLabel(journal[i].text)).toEqual({ type: 'table', label: 'Table 1' });
  });

  it('anchors a section heading to its body paragraphs, skipping the caption inside it', () => {
    const i = at('1. Introduction');
    expect(anchorOf(journal, i)?.type).toBe('section');
    expect(sectionBody(journal, i).map((block) => block.text.slice(0, 20))).toEqual([
      'Probiotics are live ',
      'Growth was measured ',
      'The isolates were fu',
    ]);
  });

  it('never anchors headed back matter, even when its paragraphs are not marked as references', () => {
    const block = (text: string, kind: string) => ({ page: 9, text, kind, isRef: false });
    const blocks = [
      block('References', 'heading'),
      block('1. Smith J. Gut bacteria. Nature 2020.', 'body'),
      block('Author Contributions', 'heading'),
      block('A.B. wrote the paper.', 'body'),
      block('Methods', 'heading'),
      block('Mice were fed a high-fat diet.', 'body'),
    ];
    expect(blocks.map((_, i) => anchorOf(blocks, i)?.key ?? null)).toEqual([null, null, null, null, 'Methods', null]);
  });

  it('excludes additional research back matter headings', () => {
    for (const heading of ['Code Availability', 'Data and Code Availability', 'Availability of Data and Materials',
      'Reproducibility Statement', 'Broader Impacts', 'Declarations', 'Checklist']) {
      const blocks = [
        { page: 1, text: heading, kind: 'heading', isRef: false },
        { page: 1, text: 'Details follow.', kind: 'body', isRef: false },
      ];
      expect(anchorOf(blocks, 0)).toBeNull();
    }
  });

  it('reads figure labels and rejects supplementary items and prose', () => {
    expect(captionLabel('Fig. 2A. Growth')).toEqual({ type: 'figure', label: 'Figure 2A' });
    expect(captionLabel('Table IV: Strains')).toEqual({ type: 'table', label: 'Table IV' });
    expect(captionLabel('Algorithm 1 Gradient descent')).toEqual({ type: 'figure', label: 'Algorithm 1' });
    expect(captionLabel('Listing 2: Code')).toEqual({ type: 'figure', label: 'Listing 2' });
    expect(captionLabel('Table A.1: Results')).toEqual({ type: 'table', label: 'Table A.1' });
    expect(captionLabel('Figure 1.2 Phase diagram')).toEqual({ type: 'figure', label: 'Figure 1.2' });
    expect(captionLabel('그림 3. 실험 장치')).toEqual({ type: 'figure', label: '그림 3' });
    expect(captionLabel('표 2 측정값')).toEqual({ type: 'table', label: '표 2' });
    expect(captionLabel('Supplementary Table S1 lists')).toBeNull();
    expect(captionLabel('Tables and figures')).toBeNull();
    expect(captionLabel('Figure in the appendix')).toBeNull();
  });

  it('matches body mentions of a label without matching longer numbers', () => {
    expect(mentionPattern('Figure 3').test('as shown in Fig. 3')).toBe(true);
    expect(mentionPattern('Figure 3').test('see Figs 3 and 4')).toBe(true);
    expect(mentionPattern('Figure 3').test('as shown in Fig. 30')).toBe(false);
    expect(mentionPattern('Table 1').test('listed in Tables 1–2')).toBe(true);
    expect(mentionPattern('Figure 1').test('Figure 1.2')).toBe(false);
    expect(mentionPattern('Figure 1').test('Fig. 1.')).toBe(true);
    expect(mentionPattern('Algorithm 2').test('Alg. 2')).toBe(true);
    expect(mentionPattern('그림 3').test('그림 3.2')).toBe(false);
    expect(mentionPattern('표 2').test('표 2 결과')).toBe(true);
    expect(captionKindName('Algorithm 1')).toBe('알고리즘');
    expect(captionKindName('Listing 2')).toBe('코드');
    expect(captionKindName('표 2')).toBe('표');
  });

  it('finds every anchor again from its serialized form', () => {
    const anchors = journal.map((_, i) => anchorOf(journal, i)).filter((a) => a !== null);
    expect(anchors.length).toBeGreaterThanOrEqual(2);
    for (const a of anchors) {
      const parsed = parseAnchor(JSON.parse(anchorId(a)));
      expect(parsed).toEqual(a);
      expect(anchorOf(journal, findAnchor(journal, parsed!))).toEqual(a);
    }
  });

  it('rejects malformed anchors', () => {
    expect(parseAnchor({ type: 'section', page: 0, key: 'x' })).toBeNull();
    expect(parseAnchor({ type: 'equation', page: 1, key: 'x' })).toBeNull();
    expect(parseAnchor({ type: 'figure', page: 1, key: 'x'.repeat(61) })).toBeNull();
    expect(parseAnchor({ type: 'figure', page: 1, key: '' })).toBeNull();
  });
});
