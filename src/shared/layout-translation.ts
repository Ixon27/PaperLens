import type { MadeBy } from './models';

/** Coordinates follow PDF.js's default-rotation, scale-one viewport (top-left points). */
export interface LayoutTranslationRegion {
  id: string;
  source: string;
  ko: string | null;
  box: [number, number, number, number];
  fontSize: number;
  rotation: number;
  origin: 'pdf' | 'ocr';
  kind: 'text' | 'protected';
  confidence: number;
  /** Erasure is allowed only when the original drawing can be preserved. */
  safe: boolean;
  reason?: string;
}

export interface LayoutTranslationPage {
  page: number;
  width: number;
  height: number;
  regions: LayoutTranslationRegion[];
  warnings: string[];
}

export interface LayoutTranslationDocument {
  version: 1;
  pdfHash: string;
  pages: LayoutTranslationPage[];
  by: MadeBy | null;
  updatedAt: string;
  /** At least one page has completed local OCR; not a claim that every page did. */
  ocr: boolean;
}
