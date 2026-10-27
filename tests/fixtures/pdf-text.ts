import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import type { TextViewport } from '../../src/server/pdf/layout';

/** PDF.js items use a bottom-left baseline, not a top-left line box. */
export function textItem(str: string, x: number, baseline: number, width: number, size = 12, fontName = 'body'): TextItem {
  return { str, dir: 'ltr', transform: [size, 0, 0, size, x, baseline], width, height: size, fontName, hasEOL: true };
}

export function textContent(items: TextContent['items']): TextContent {
  return {
    items,
    styles: {
      body: { ascent: 0.8, descent: -0.2, vertical: false, fontFamily: 'serif' },
      heading: { ascent: 0.8, descent: -0.2, vertical: false, fontFamily: 'sans-serif' },
    },
    lang: 'en',
  };
}

export const letterViewport: TextViewport = { width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] };
export const a4Viewport: TextViewport = { width: 595.28, height: 841.89, transform: [1, 0, 0, -1, 0, 841.89] };

export const firstPage = textContent([
  textItem('References', 72, 722.4, 100),
  // Separate font runs on the same baseline must still form one line.
  { ...textItem('The gut ', 72, 682.2, 43, 12.25), hasEOL: false },
  textItem('micro-', 115, 682.2, 175.5, 12.25),
  textItem('biome of Gram-', 72, 668.2, 228, 12.25),
  textItem('Negative bacteria & IL-', 72, 654.2, 208, 12.25),
  textItem('6 levels.', 72, 640.2, 58, 12.25),
  textItem('   ', 72, 600, 20),
]);

export const secondPage = textContent([
  textItem('Methods', 72, 772.29, 128),
  textItem('5. References', 72, 748.29, 130),
  textItem('1. Smith J. Gut bacteria. Nature 2020.', 72, 724.29, 428),
  textItem('2. Lee K. Microbiome "dark matter" <review>.', 72, 700.29, 428),
  textItem('Supplementary Materials', 72, 676.29, 228),
  textItem('Table S1 lists all primers.', 72, 652.29, 228),
]);

// Deliberately emitted in row order, with the right column's items first.
export const twoColumns = textContent([
  textItem('A full-width paper title', 50, 730, 510, 18, 'heading'),
  textItem('Right column first', 330, 680, 225),
  textItem('Left column first', 50, 680, 225),
  textItem('right continuation', 330, 666, 225),
  textItem('left continuation', 50, 666, 225),
  textItem('right ending.', 330, 652, 190),
  textItem('left ending.', 50, 652, 190),
  textItem('Results', 50, 600, 510, 14, 'heading'),
  textItem('Lower right first', 330, 560, 225),
  textItem('Lower left first', 50, 560, 225),
  textItem('lower right continuation', 330, 546, 225),
  textItem('lower left continuation', 50, 546, 225),
  textItem('lower right ending.', 330, 532, 190),
  textItem('lower left ending.', 50, 532, 190),
]);

const BODY = 10;
/** A justified body line of the 166–560pt text column (first lines of paragraphs are indented to 188). */
const body = (str: string, baseline: number, x = 166, width = 394) => textItem(str, x, baseline, width, BODY);

/**
 * Two pages in a common journal layout: running header, page numbers and a DOI footer on both pages,
 * front matter before the abstract, small-type margin notes beside the body column (on the same
 * baselines as body lines), a paragraph running onto the next page with a hyphenated break, and a
 * captioned table of short cells.
 */
export const journalPages = [
  textContent([
    textItem('Journal of Tests 2026, 14, 385', 36, 806, 120, 8),
    textItem('1 of 2', 536, 806, 24, 8),
    textItem('A Test Article About Layout', 36, 760, 400, 18, 'heading'),
    textItem('Ann Author and Bob Writer', 36, 735, 200, BODY, 'heading'),
    textItem('Abstract', 166, 700, 50, BODY, 'heading'),
    body('Cells grow in rich media and we measured how they respond to stress over', 686),
    body('several days. The response depends on the strain and on the medium that was', 672),
    body('used for growth.', 658, 166, 80),
    textItem('1. Introduction', 166, 630, 90, 12, 'heading'),
    textItem('Received: 1 May 2026', 36, 600, 110, 7),
    body('Probiotics are live microorganisms that confer health benefits when given in', 600, 188, 372),
    textItem('Accepted: 2 June 2026', 36, 586, 110, 7),
    body('adequate amounts, and isolates from the skin were subcultured into fresh broths.', 586),
    body('To obtain pure isolates the cultures were streaked again onto fresh agar and', 572),
    body('stored frozen until the experiments described below were ap-', 558),
    textItem('https://doi.org/10.1234/test.385', 380, 30, 180, 8),
  ]),
  textContent([
    textItem('Journal of Tests 2026, 14, 385', 36, 806, 120, 8),
    textItem('2 of 2', 536, 806, 24, 8),
    body('plied to every sample in the study.', 770, 166, 160),
    body('Growth was measured daily and compared between the two groups, always', 756, 188, 372),
    body('in triplicate for each isolate.', 742, 166, 140),
    textItem('Table 1. Isolates and their identification.', 166, 710, 220, 9, 'heading'),
    textItem('Isolate', 200, 690, 40, BODY, 'heading'),
    textItem('Species', 300, 690, 50, BODY, 'heading'),
    textItem('Score', 450, 690, 35, BODY, 'heading'),
    textItem('S1', 200, 676, 12, BODY),
    textItem('Lactobacillus', 300, 676, 60, BODY),
    textItem('99.7%', 450, 676, 30, BODY),
    body('The isolates were further confirmed by mass spectrometry, which is more', 650, 188, 372),
    body('reliable than biochemical tests.', 636, 166, 150),
    textItem('https://doi.org/10.1234/test.385', 380, 30, 180, 8),
  ]),
];
