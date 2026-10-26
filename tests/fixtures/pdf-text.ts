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
  textItem('right ending', 330, 652, 190),
  textItem('left ending', 50, 652, 190),
  textItem('Results', 50, 600, 510, 14, 'heading'),
  textItem('Lower right first', 330, 560, 225),
  textItem('Lower left first', 50, 560, 225),
  textItem('lower right continuation', 330, 546, 225),
  textItem('lower left continuation', 50, 546, 225),
  textItem('lower right ending', 330, 532, 190),
  textItem('lower left ending', 50, 532, 190),
]);
