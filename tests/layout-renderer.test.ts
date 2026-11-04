import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCanvas, GlobalFonts, type Canvas } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { exportLayoutPdf, inspectLayoutRegionPixels, renderLayoutPage } from '../src/web/pdf/layoutRenderer';
import type { LayoutTranslationPage, LayoutTranslationRegion } from '../src/shared/layout-translation';

beforeAll(() => {
  GlobalFonts.registerFromPath(fileURLToPath(new URL('../src/web/fonts/NotoSansCJKkr-Regular.otf', import.meta.url)), 'PaperLens Noto Sans KR');
});
afterEach(() => vi.unstubAllGlobals());

function browserCanvas(width = 200, height = 120): HTMLCanvasElement {
  const canvas = createCanvas(width, height) as Canvas & { toBlob?: (callback: (blob: Blob) => void) => void };
  canvas.toBlob = (callback) => callback(new Blob([new Uint8Array(canvas.toBuffer('image/png'))], { type: 'image/png' }));
  return canvas as unknown as HTMLCanvasElement;
}

function browserDocument() {
  const fonts = { load: vi.fn(async () => [{}]), ready: Promise.resolve() };
  vi.stubGlobal('document', { fonts, createElement: () => browserCanvas() });
  return fonts;
}

function region(overrides: Partial<LayoutTranslationRegion> = {}): LayoutTranslationRegion {
  return { id: 'text-1', source: 'Original', ko: '한국어 번역', box: [10, 10, 100, 32], fontSize: 10,
    rotation: 0, origin: 'pdf', kind: 'text', confidence: 1, safe: true, ...overrides };
}

function page(regions = [region()]): LayoutTranslationPage {
  return { page: 1, width: 200, height: 120, regions, warnings: [] };
}

function originalCanvas(): HTMLCanvasElement {
  const canvas = browserCanvas();
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#fff'; context.fillRect(0, 0, 200, 120);
  context.fillStyle = '#000'; context.font = '10px sans-serif'; context.fillText('Original', 15, 24);
  // A table rule and a figure outside the replaceable rectangle must survive byte-for-byte.
  context.fillRect(0, 70, 200, 1); context.fillStyle = '#789'; context.fillRect(140, 10, 40, 40);
  return canvas;
}

function pixels(canvas: HTMLCanvasElement): Uint8ClampedArray {
  return canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
}

describe('layout compositor native-canvas smoke hooks', () => {
  it('awaits the bundled font and preserves source plus every outside pixel', async () => {
    const fonts = browserDocument();
    const original = originalCanvas();
    const before = pixels(original).slice();
    const data = page();
    const dataBefore = JSON.stringify(data);
    const result = await renderLayoutPage(original, data);
    expect(fonts.load).toHaveBeenCalledWith(expect.stringContaining('PaperLens Noto Sans KR'), '한글 번역');
    expect(result.placements[0].status).toBe('translated');
    expect(pixels(original)).toEqual(before);
    expect(JSON.stringify(data)).toBe(dataBefore);
    const after = pixels(result.canvas);
    let changedInside = false;
    for (let y = 0; y < original.height; y++) {
      for (let x = 0; x < original.width; x++) {
        const offset = (y * original.width + x) * 4;
        const inside = x >= 10 && x < 110 && y >= 10 && y < 42;
        for (let channel = 0; channel < 4; channel++) {
          if (!inside) expect(after[offset + channel]).toBe(before[offset + channel]);
          else if (after[offset + channel] !== before[offset + channel]) changedInside = true;
        }
      }
    }
    expect(changedInside).toBe(true);
  });

  it('does not measure or compose before document fonts are ready', async () => {
    const fonts = browserDocument();
    const ready = Promise.withResolvers<void>();
    fonts.ready = ready.promise;
    const createElement = vi.spyOn(document, 'createElement');
    const pending = renderLayoutPage(originalCanvas(), page());
    await Promise.resolve();
    expect(createElement).not.toHaveBeenCalled();
    ready.resolve();
    expect((await pending).placements[0].status).toBe('translated');
  });

  it('preserves original pixels for unsafe, rotated, OCR, protected and overflowing text', async () => {
    browserDocument();
    const cases = [
      { input: region({ safe: false }), status: 'unsafe' },
      { input: region({ rotation: 90 }), status: 'unsafe' },
      { input: region({ origin: 'ocr', safe: false }), status: 'unsafe' },
      { input: region({ kind: 'protected' }), status: 'protected' },
      { input: region({ ko: null }), status: 'untranslated' },
      { input: region({ ko: '모든 번역을 끝까지 보존합니다. '.repeat(100) }), status: 'overflow' },
      { input: region({ box: [-1, 10, 100, 32] }), status: 'unsafe' },
    ];
    for (const { input, status } of cases) {
      const original = originalCanvas();
      const result = await renderLayoutPage(original, page([input]));
      expect(result.placements[0]).toMatchObject({ status, source: input.source, ko: input.ko, reason: expect.any(String) });
      expect(pixels(result.canvas)).toEqual(pixels(original));
    }
  });

  it('never paints through protected overlapping regions or through table rules', async () => {
    browserDocument();
    const original = originalCanvas();
    const overlap = await renderLayoutPage(original, page([region(), region({ id: 'equation', kind: 'protected', box: [50, 10, 5, 5] })]));
    expect(overlap.placements.map((placement) => placement.status)).toEqual(['unsafe', 'protected']);
    expect(pixels(overlap.canvas)).toEqual(pixels(original));
    const rules = await renderLayoutPage(original, page([region({ box: [0, 60, 190, 20] })]));
    expect(rules.placements[0].status).toBe('unsafe');
    expect(pixels(rules.canvas)).toEqual(pixels(original));
  });

  it('allows engine-proven safe OCR while applying the same raster guards', async () => {
    browserDocument();
    const original = originalCanvas();
    const input = page([region({ origin: 'ocr', safe: true, confidence: 0.99 })]);
    const result = await renderLayoutPage(original, input);
    expect(result.placements[0].status).toBe('translated');
    original.getContext('2d')!.fillStyle = '#eee';
    original.getContext('2d')!.fillRect(10, 10, 100, 32);
    const preserved = await renderLayoutPage(original, input);
    expect(preserved.placements[0].status).toBe('unsafe');
    expect(pixels(preserved.canvas)).toEqual(pixels(original));
  });

  it('distinguishes tight-box Latin stems from long graph strokes at the source font scale', () => {
    const canvas = browserCanvas(100, 22);
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#fff'; context.fillRect(0, 0, 100, 22);
    context.fillStyle = '#000';
    context.fillRect(10, 2, 2, 18); context.fillRect(24, 2, 2, 18);
    const stems = context.getImageData(0, 0, 100, 22);
    expect(inspectLayoutRegionPixels(stems)).toMatch(/수직/);
    expect(inspectLayoutRegionPixels(stems, 20)).toBeNull();

    const graph = browserCanvas(100, 70);
    const drawing = graph.getContext('2d')!;
    drawing.fillStyle = '#fff'; drawing.fillRect(0, 0, 100, 70);
    drawing.fillStyle = '#000'; drawing.fillRect(10, 2, 1, 66);
    expect(inspectLayoutRegionPixels(drawing.getImageData(0, 0, 100, 70), 20)).toMatch(/수직/);
    drawing.fillStyle = '#fff'; drawing.fillRect(0, 0, 100, 70);
    drawing.fillStyle = '#000'; drawing.fillRect(2, 10, 96, 1);
    expect(inspectLayoutRegionPixels(drawing.getImageData(0, 0, 100, 70), 20)).toMatch(/수평/);
  });

  it('rejects nonwhite backgrounds, dense image ink and long internal rules', () => {
    const canvas = browserCanvas(80, 40);
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#eee'; context.fillRect(0, 0, 80, 40);
    expect(inspectLayoutRegionPixels(context.getImageData(0, 0, 80, 40))).toMatch(/흰색/);
    context.fillStyle = '#fff'; context.fillRect(0, 0, 80, 40);
    context.fillStyle = '#000'; context.fillRect(2, 10, 76, 1);
    expect(inspectLayoutRegionPixels(context.getImageData(0, 0, 80, 40))).toMatch(/수평/);
    context.fillStyle = '#fff'; context.fillRect(0, 0, 80, 40);
    context.fillStyle = '#000'; context.fillRect(10, 2, 1, 36);
    expect(inspectLayoutRegionPixels(context.getImageData(0, 0, 80, 40))).toMatch(/수직/);
    context.fillStyle = '#fff'; context.fillRect(0, 0, 80, 40);
    const dense = context.getImageData(0, 0, 80, 40);
    for (let y = 1; y < 39; y++) {
      for (let x = 1; x < 79; x++) {
        if ((x + y) % 2 === 0) {
          const offset = (y * 80 + x) * 4;
          dense.data[offset] = dense.data[offset + 1] = dense.data[offset + 2] = 0;
        }
      }
    }
    expect(inspectLayoutRegionPixels(dense)).toMatch(/조밀/);
  });

  it('exports raster page dimensions/orientation and full preserved-region appendix', async () => {
    browserDocument();
    const fullKorean = '누락 없이 한국어 전체 번역을 부록에 보존합니다. '.repeat(200);
    const portrait = { ...page([region({ ko: fullKorean, safe: false })]), width: 120, height: 200 };
    const landscape = { ...page(), page: 2 };
    const progress = vi.fn();
    const output = await exportLayoutPdf({ pages: [portrait, landscape], onProgress: progress, renderPage: async (data) => {
      const canvas = browserCanvas(data.width * 2, data.height * 2);
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      return renderLayoutPage(canvas, data);
    } });
    const pdf = await PDFDocument.load(await output.arrayBuffer());
    expect(pdf.getPage(0).getSize()).toEqual({ width: 120, height: 200 });
    expect(pdf.getPage(1).getSize()).toEqual({ width: 200, height: 120 });
    expect(pdf.getPageCount()).toBeGreaterThan(3);
    expect(progress.mock.calls).toEqual([[1, 2], [2, 2]]);
  });

  it('aborts without changing its source and rejects missing fonts or mismatched orientation', async () => {
    const fonts = browserDocument();
    const original = originalCanvas();
    const controller = new AbortController(); controller.abort();
    await expect(renderLayoutPage(original, page(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(renderLayoutPage(original, { ...page(), width: 120, height: 200 })).rejects.toThrow(/방향/);
    fonts.load.mockResolvedValueOnce([]);
    await expect(renderLayoutPage(original, page())).rejects.toThrow(/글꼴/);
  });
});
