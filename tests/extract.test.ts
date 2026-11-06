import { describe, expect, it } from 'vitest';
import { layoutDocument, type Block, type PageText } from '../src/server/pdf/layout';
import { a4Viewport, firstPage, journalPages, letterViewport, secondPage, textContent, textItem, twoColumns } from './fixtures/pdf-text';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';

const onePage = (content: TextContent, viewport = letterViewport) => layoutDocument([{ viewport, content }]);

const blocks = layoutDocument([
  { viewport: letterViewport, content: firstPage },
  { viewport: a4Viewport, content: secondPage },
]);
const byText = (prefix: string, list: Block[] = blocks) => list.find((block) => block.text.startsWith(prefix))!;

const journal = layoutDocument(journalPages.map((content): PageText => ({ viewport: a4Viewport, content })));
const reading = (list: Block[]) => list.filter((block) => block.kind !== 'aside' && !block.isRef).map((block) => block.text);

describe('PDF.js text layout', () => {
  it('keeps paragraphs rather than flattening a page or returning one block per line', () => {
    expect(blocks.map((block) => block.idx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(blocks.map((block) => block.page)).toEqual([1, 1, 2, 2, 2, 2, 2, 2]);
    expect(byText('The gut').lines).toHaveLength(4);
    expect(byText('Methods').lines).toHaveLength(1);
  });

  it('joins font runs and repairs hyphenated words without breaking compounds or identifiers', () => {
    expect(byText('The gut').text).toBe('The gut microbiome of Gram-Negative bacteria & IL-6 levels.');
    expect(byText('2.').text).toBe('2. Lee K. Microbiome "dark matter" <review>.');
  });

  it.each([
    ['k-', 'means', 'k-means'],
    ['self-', 'attention', 'self-attention'],
    ['state-of-the-', 'art', 'state-of-the-art'],
    ['micro-', 'biome', 'microbiome'],
  ])('joins %s and %s with aligned spans', (left, right, expected) => {
    const page = onePage(textContent([
      textItem(left, 72, 690, 300),
      textItem(right, 72, 676, 300),
    ]));
    expect(page).toHaveLength(1);
    expect(page[0].text).toBe(expected);
    expect(page[0].spans.map(([, , start, end]) => page[0].text.slice(start, end))).toEqual([
      expected.slice(0, expected.length - right.length), right,
    ]);
  });

  it('recognizes algorithm captions', () => {
    const page = onePage(textContent([
      textItem('Algorithm 1 Stochastic gradient descent', 72, 690, 300),
    ]));
    expect(byText('Algorithm 1', page).kind).toBe('caption');
  });

  it('marks only blocks after the LAST references heading', () => {
    expect(blocks.filter((block) => block.isRef).map((block) => block.text)).toEqual([
      '1. Smith J. Gut bacteria. Nature 2020.',
      '2. Lee K. Microbiome "dark matter" <review>.',
    ]);
    expect(byText('References').isRef).toBe(false);
    expect(byText('5. References').isRef).toBe(false);
    expect(byText('Table S1').isRef).toBe(false);
  });

  it.each(['Supplementary Materials', 'Appendix A', 'Acknowledgements', 'Figure legends'])('stops reference marking at %s', (heading) => {
    const page = onePage(textContent([
      textItem('References', 72, 720, 100),
      textItem('1. Smith J. A reference.', 72, 690, 300),
      textItem(heading, 72, 660, 250),
      textItem('Back matter is not a reference.', 72, 630, 300),
    ]));
    expect(page.filter((block) => block.isRef).map((block) => block.text)).toEqual(['1. Smith J. A reference.']);
  });

  it('stops references at a subsequent heading', () => {
    const page = onePage(textContent([
      textItem('References', 72, 720, 100),
      textItem('1. Smith J. A reference.', 72, 690, 300),
      textItem('A Proofs', 72, 660, 120, 12, 'heading'),
      textItem('Proof details are not references.', 72, 630, 300),
    ]));
    expect(byText('A Proofs', page).kind).toBe('heading');
    expect(page.filter((block) => block.isRef).map((block) => block.text)).toEqual(['1. Smith J. A reference.']);
  });

  it('keeps page dimensions and top-left per-line boxes in PDF points', () => {
    const block = byText('The gut');
    expect([block.pageW, block.pageH]).toEqual([612, 792]);
    const expected = [[72, 100, 290.5, 112.25], [72, 114, 300, 126.25], [72, 128, 280, 140.25], [72, 142, 130, 154.25]];
    for (let line = 0; line < expected.length; line++) {
      for (let axis = 0; axis < 4; axis++) expect(block.lines[line][axis]).toBeCloseTo(expected[line][axis], 5);
    }
    expect([byText('Methods').pageW, byText('Methods').pageH]).toEqual([595.28, 841.89]);
  });

  it('reads each column top-to-bottom, with full-width material separating column bands', () => {
    const page = onePage(twoColumns);
    expect(page.map((block) => block.text)).toEqual([
      'A full-width paper title',
      'Left column first left continuation left ending.',
      'Right column first right continuation right ending.',
      'Results',
      'Lower left first lower left continuation lower left ending.',
      'Lower right first lower right continuation lower right ending.',
    ]);
    expect(page[1].lines.every((box) => box[2] < 306)).toBe(true);
    expect(page[2].lines.every((box) => box[0] > 306)).toBe(true);
  });

  it('recognizes paragraph indentation and blank vertical space within a single column', () => {
    const page = onePage(textContent([
      textItem('First paragraph begins and', 72, 700, 440),
      textItem('finishes here.', 72, 686, 200),
      textItem('Second paragraph starts indented and', 84, 672, 428),
      textItem('continues at the margin.', 72, 658, 440),
      textItem('A separated third paragraph.', 72, 625, 440),
    ]));
    expect(page.map((block) => block.text)).toEqual([
      'First paragraph begins and finishes here.',
      'Second paragraph starts indented and continues at the margin.',
      'A separated third paragraph.',
    ]);
  });

  it('keeps superscripts with the surrounding line and does not insert spaces inside words', () => {
    const page = onePage(textContent([
      { ...textItem('micro', 72, 700, 30), hasEOL: false },
      { ...textItem('biome', 102, 700, 32), hasEOL: false },
      textItem('2', 134, 704, 4, 7),
    ]));
    expect(page).toHaveLength(1);
    expect(page[0].text).toBe('microbiome2');
    expect(page[0].lines).toHaveLength(1);
  });

  it('accounts for the crop-box origin in the viewport transform', () => {
    const page = onePage(textContent([textItem('Cropped text', 70, 700, 100)]), { width: 600, height: 800, transform: [1, 0, 0, -1, -20, 820] });
    expect(page[0].lines[0][0]).toBeCloseTo(50);
    expect(page[0].lines[0][1]).toBeCloseTo(110.4);
    expect(page[0].lines[0][2]).toBeCloseTo(150);
    expect(page[0].lines[0][3]).toBeCloseTo(122.4);
  });

  it('returns no text blocks for scanned pages or whitespace-only items', () => {
    expect(onePage(textContent([]))).toEqual([]);
    expect(onePage(textContent([textItem('  ', 72, 700, 20)]))).toEqual([]);
  });
});

describe('reading text vs. everything else', () => {
  it('keeps only headings, whole paragraphs and captions as reading text', () => {
    expect(reading(journal)).toEqual([
      'A Test Article About Layout',
      'Abstract',
      'Cells grow in rich media and we measured how they respond to stress over several days. The response depends on the strain and on the medium that was used for growth.',
      '1. Introduction',
      'Probiotics are live microorganisms that confer health benefits when given in adequate amounts, and isolates from the skin were subcultured into fresh broths. ' +
        'To obtain pure isolates the cultures were streaked again onto fresh agar and stored frozen until the experiments described below were applied to every sample in the study.',
      'Growth was measured daily and compared between the two groups, always in triplicate for each isolate.',
      'Table 1. Isolates and their identification.',
      'The isolates were further confirmed by mass spectrometry, which is more reliable than biochemical tests.',
    ]);
    expect(byText('Table 1.', journal).kind).toBe('caption');
    expect(byText('1. Introduction', journal).kind).toBe('heading');
  });

  it('sets running headers, page numbers, author metadata, margin notes and table cells aside', () => {
    const notReading = ['Journal of Tests', '1 of 2', '2 of 2', 'https://doi.org', 'Ann Author', 'Received:', 'Lactobacillus', '99.7%'];
    for (const text of notReading) {
      const found = journal.filter((block) => block.text.includes(text));
      expect(found.length, text).toBeGreaterThan(0);
      expect(found.every((block) => block.kind === 'aside'), text).toBe(true);
    }
  });


  it.each(['Simple Summary', 'Lay Summary', 'Plain-language Summary', 'Author Summary'])(
    'keeps %s and all its prose before a later abstract, plus a reliable multiline article title',
    (summaryHeading) => {
      const page = onePage(textContent([
        textItem('Article', 36, 735, 28, 10),
        textItem('Dose-Dependent Effects of Microplastics on', 36, 714, 498, 18, 'heading'),
        textItem('Growth, Physiology, and Rhizosphere Microbiomes of', 36, 693, 468, 18, 'heading'),
        textItem('Medicinal Plants', 36, 672, 154, 18, 'italic'),
        textItem('Ann Author and Bob Writer', 36, 646, 230, 10, 'heading'),
        textItem('School of Biology, Example University', 166, 602, 300, 8),
        textItem('Correspondence: author@example.org', 166, 578, 300, 8),
        textItem(summaryHeading, 166, 541, 130, 10, 'heading'),
        textItem('Microplastic pollution affects medicinal plants at 0.1–2.0%. We examined', 166, 521, 394, 10),
        textItem('plant growth and soil communities for 60 days. The effects depended on', 166, 507, 394, 10),
        textItem('dose, with changes in pH and 16S rRNA abundance.', 166, 493, 290, 10),
        textItem('Abstract', 166, 459, 50, 10, 'heading'),
        textItem('We tested the growth response across several doses. All values were', 166, 439, 394, 10),
        textItem('measured independently and compared with untreated controls.', 166, 425, 394, 10),
      ]), a4Viewport);
      expect(byText('Dose-Dependent', page)).toMatchObject({
        kind: 'heading',
        text: 'Dose-Dependent Effects of Microplastics on Growth, Physiology, and Rhizosphere Microbiomes of Medicinal Plants',
      });
      expect(byText('Dose-Dependent', page).lines).toHaveLength(3);
      expect(byText(summaryHeading, page).kind).toBe('heading');
      const summary = byText('Microplastic pollution', page);
      expect(summary.kind).toBe('body');
      expect(summary.text).toBe('Microplastic pollution affects medicinal plants at 0.1–2.0%. We examined plant growth and soil communities for 60 days. The effects depended on dose, with changes in pH and 16S rRNA abundance.');
      expect(summary.lines).toHaveLength(3);
      expect(summary.spans.map(([, , start, end]) => summary.text.slice(start, end))).toEqual([
        'Microplastic pollution affects medicinal plants at 0.1–2.0%. We examined',
        'plant growth and soil communities for 60 days. The effects depended on',
        'dose, with changes in pH and 16S rRNA abundance.',
      ]);
      expect(byText('Abstract', page).kind).toBe('heading');
      expect(byText('We tested', page).kind).toBe('body');
      for (const prefix of ['Article', 'Ann Author', 'School of Biology', 'Correspondence:']) {
        expect(byText(prefix, page).kind).toBe('aside');
      }
    },
  );

  it('does not guess an article title from ordinary author or affiliation lines', () => {
    const page = onePage(textContent([
      textItem('Ann Author and Bob Writer', 72, 700, 300),
      textItem('School of Biology at Example University', 72, 680, 400),
      textItem('Abstract', 72, 640, 70, 12, 'heading'),
      textItem('The experiment used untreated controls. Samples were compared.', 72, 620, 440),
    ]));
    for (const text of ['Ann Author', 'School of Biology']) {
      const found = page.filter((block) => block.text.includes(text));
      expect(found.length, text).toBeGreaterThan(0);
      expect(found.every((block) => block.kind === 'aside'), text).toBe(true);
    }
    expect(page.filter((block) => block.kind === 'heading').map((block) => block.text)).toEqual(['Abstract']);
  });
  it('continues a paragraph onto the next page, marking the lines that moved', () => {
    const paragraph = byText('Probiotics', journal);
    expect(paragraph.page).toBe(1);
    expect(paragraph.lines.map((line) => line[4] ?? paragraph.page)).toEqual([1, 1, 1, 1, 2]);
    expect(paragraph.lines.slice(0, 4).every((line) => line.length === 4)).toBe(true);
  });

  it('maps block characters to the text-layer item that draws them, across hyphen repair and pages', () => {
    const paragraph = byText('Probiotics', journal);
    const slice = ([, , start, end]: Block['spans'][number]) => paragraph.text.slice(start, end);
    // Page 1 numbers its 16 non-empty items 0–15 in content order; "stored frozen…ap-" is the 15th.
    const stored = paragraph.spans.find((span) => slice(span) === 'stored frozen until the experiments described below were ap');
    expect(stored?.slice(0, 2)).toEqual([1, 14]);
    const last = paragraph.spans.at(-1)!;
    expect(last.slice(0, 2)).toEqual([2, 2]);
    expect(slice(last)).toBe('plied to every sample in the study.');
  });
});
