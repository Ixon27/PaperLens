import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { layoutDocument, type Block, type PageText } from './layout';

export type { Block, BlockKind, LineBox } from './layout';

export interface ExtractionResult {
  pageCount: number;
  blocks: Block[];
  /** Usable PDF metadata title; callers fall back to the uploaded filename. */
  title: string | null;
}

const pdfjsRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
// Electron utility processes are not auto-detected as Node by PDF.js 4.
// Use its local in-process worker and file-backed font resources explicitly.
GlobalWorkerOptions.workerSrc = pathToFileURL(join(pdfjsRoot, 'legacy/build/pdf.worker.mjs')).href;

function resourcePath(directory: string, name: string): string {
  if (!name || name !== basename(name) || name.includes('\\')) throw new Error('잘못된 PDF 글꼴 리소스 이름');
  return join(pdfjsRoot, directory, name);
}

class LocalCMapReader {
  async fetch({ name }: { name: string }) {
    return { cMapData: await readFile(resourcePath('cmaps', `${name}.bcmap`)), compressionType: 1 };
  }
}

class LocalStandardFonts {
  async fetch({ filename }: { filename: string }) {
    return readFile(resourcePath('standard_fonts', filename));
  }
}

/** Parse once for metadata and all page text; no renderer or external program is needed. */
export async function extractBlocks(pdfPath: string): Promise<ExtractionResult> {
  const bytes = await readFile(pdfPath);
  const loading = getDocument({
    data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    useWorkerFetch: false,
    CMapReaderFactory: LocalCMapReader,
    StandardFontDataFactory: LocalStandardFonts,
  });
  try {
    const pdf = await loading.promise;
    const pages: PageText[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      try {
        // Unrotated PDF-point coordinates match the viewer's scaled-coordinate contract.
        pages.push({ viewport: page.getViewport({ scale: 1, rotation: 0 }), content: await page.getTextContent() });
      } finally {
        page.cleanup();
      }
    }
    // Headers, footers and the body type size are only recognizable across the whole document.
    const blocks: Block[] = layoutDocument(pages);
    let title: string | null = null;
    try {
      const { info, metadata } = await pdf.getMetadata();
      const raw: unknown = 'Title' in info ? info.Title : metadata?.get('dc:title');
      if (typeof raw === 'string' && raw.trim().length >= 15) title = raw.trim();
    } catch {
      // Broken/missing metadata must not discard otherwise readable page text.
    }
    return { pageCount: pdf.numPages, blocks, title };
  } finally {
    await loading.destroy();
  }
}
