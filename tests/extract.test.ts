import { describe, expect, it } from 'vitest';
import { markReferences, pageBlocks } from '../src/server/pdf/layout';
import { a4Viewport, firstPage, letterViewport, secondPage, textContent, textItem, twoColumns } from './fixtures/pdf-text';

const blocks = [
  ...pageBlocks(1, letterViewport, firstPage),
  ...pageBlocks(2, a4Viewport, secondPage, 2),
];
markReferences(blocks);
const byText = (prefix: string) => blocks.find((block) => block.text.startsWith(prefix))!;

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
    const page = pageBlocks(1, letterViewport, textContent([
      textItem('References', 72, 720, 100),
      textItem('1. Smith J. A reference.', 72, 690, 300),
      textItem(heading, 72, 660, 250),
      textItem('Back matter is not a reference.', 72, 630, 300),
    ]));
    markReferences(page);
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
    const page = pageBlocks(3, letterViewport, twoColumns, 8);
    expect(page.map((block) => block.text)).toEqual([
      'A full-width paper title',
      'Left column first left continuation left ending',
      'Right column first right continuation right ending',
      'Results',
      'Lower left first lower left continuation lower left ending',
      'Lower right first lower right continuation lower right ending',
    ]);
    expect(page.map((block) => block.idx)).toEqual([8, 9, 10, 11, 12, 13]);
    expect(page[1].lines.every((box) => box[2] < 306)).toBe(true);
    expect(page[2].lines.every((box) => box[0] > 306)).toBe(true);
  });

  it('recognizes paragraph indentation and blank vertical space within a single column', () => {
    const page = pageBlocks(1, letterViewport, textContent([
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
    const page = pageBlocks(1, letterViewport, textContent([
      { ...textItem('micro', 72, 700, 30), hasEOL: false },
      { ...textItem('biome', 102, 700, 32), hasEOL: false },
      textItem('2', 134, 704, 4, 7),
    ]));
    expect(page).toHaveLength(1);
    expect(page[0].text).toBe('microbiome2');
    expect(page[0].lines).toHaveLength(1);
  });

  it('accounts for the crop-box origin in the viewport transform', () => {
    const page = pageBlocks(1, { width: 600, height: 800, transform: [1, 0, 0, -1, -20, 820] }, textContent([
      textItem('Cropped text', 70, 700, 100),
    ]));
    expect(page[0].lines[0][0]).toBeCloseTo(50);
    expect(page[0].lines[0][1]).toBeCloseTo(110.4);
    expect(page[0].lines[0][2]).toBeCloseTo(150);
    expect(page[0].lines[0][3]).toBeCloseTo(122.4);
  });

  it('returns no text blocks for scanned pages or whitespace-only items', () => {
    expect(pageBlocks(1, letterViewport, textContent([]))).toEqual([]);
    expect(pageBlocks(1, letterViewport, textContent([textItem('  ', 72, 700, 20)]))).toEqual([]);
  });
});
