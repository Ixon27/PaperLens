import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker as NodeWorker } from 'node:worker_threads';
import { createCanvas, DOMMatrix, ImageData, Path2D, type Canvas } from '@napi-rs/canvas';
import { getDocument, GlobalWorkerOptions, OPS, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Page as OcrPage } from 'tesseract.js';
import type { LayoutTranslationPage, LayoutTranslationRegion } from '../../shared/layout-translation';
import { duplicatesNative, inlineRasterDivider, inlineUnionBox, multiply, nativeRegion, ocrGlyphRaster, overlaps, plainRaster, protectedSource, refineNativeBoxes, transformedBox, type Box, type Matrix } from './layout-translation-geometry';

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
GlobalWorkerOptions.workerSrc = pathToFileURL(join(pdfjsRoot, 'legacy/build/pdf.worker.mjs')).href;
for (const [name, value] of Object.entries({ DOMMatrix, ImageData, Path2D })) if (!(name in globalThis)) Object.defineProperty(globalThis, name, { value, configurable: true });
const MAX_PDF_BYTES = 150 * 1024 * 1024;
export const MAX_LAYOUT_PAGES = 2000;
const MAX_REGIONS = 12_000;
const MAX_PAGE_CHARS = 100_000;

export interface LayoutPdf {
  pdf: PDFDocumentProxy;
  hash: string;
  close(): Promise<void>;
}

export interface LayoutOcrWorker {
  recognize(image: Buffer): Promise<{ data: Pick<OcrPage, 'blocks'> }>;
  terminate(): Promise<void>;
}

/** Cancellation must reject pending Tesseract requests: terminate alone leaves them unresolved. */
export async function abortableLayoutWork<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); signal.throwIfAborted(); }
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try { return await Promise.race([work, aborted.promise]); }
  finally { signal.removeEventListener('abort', abort); }
}

function resource(directory: string, name: string): string {
  if (!name || name !== basename(name) || name.includes('\\')) throw new Error('잘못된 PDF 리소스 이름');
  return join(pdfjsRoot, directory, name);
}
class LocalCMapReader {
  async fetch({ name }: { name: string }) { return { cMapData: await readFile(resource('cmaps', `${name}.bcmap`)), compressionType: 1 }; }
}
class LocalStandardFonts {
  async fetch({ filename }: { filename: string }) { return readFile(resource('standard_fonts', filename)); }
}
class LocalCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(Math.ceil(width), Math.ceil(height));
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(target: { canvas: Canvas }, width: number, height: number) { target.canvas.width = Math.ceil(width); target.canvas.height = Math.ceil(height); }
  destroy(target: { canvas: Canvas | null; context: unknown }) {
    if (target.canvas) { target.canvas.width = 1; target.canvas.height = 1; }
    target.canvas = null;
    target.context = null;
  }
}

/** Hash exact original bytes before PDF.js can transfer its input to the worker. */
export async function layoutPdfHash(path: string): Promise<string> {
  if ((await stat(path)).size > MAX_PDF_BYTES) throw new Error('원문 배치 번역은 150MB 이하 PDF를 지원합니다');
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
export async function openLayoutPdf(path: string, signal?: AbortSignal): Promise<LayoutPdf> {
  signal?.throwIfAborted();
  if ((await stat(path)).size > MAX_PDF_BYTES) throw new Error('원문 배치 번역은 150MB 이하 PDF를 지원합니다');
  const bytes = await readFile(path);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const task = getDocument({ data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), useSystemFonts: false, isEvalSupported: false, disableFontFace: true, isOffscreenCanvasSupported: false, useWorkerFetch: false, CMapReaderFactory: LocalCMapReader, StandardFontDataFactory: LocalStandardFonts, CanvasFactory: LocalCanvasFactory, stopAtErrors: true });
  const abort = () => { void task.destroy(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const pdf = await abortableLayoutWork(task.promise, AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]));
    signal?.throwIfAborted();
    if (pdf.numPages > MAX_LAYOUT_PAGES) throw new Error(`원문 배치 번역은 ${MAX_LAYOUT_PAGES}페이지 이하 PDF를 지원합니다`);
    return { pdf, hash, close: async () => { signal?.removeEventListener('abort', abort); await task.destroy(); } };
  } catch (error) {
    signal?.removeEventListener('abort', abort);
    await task.destroy();
    throw error;
  }
}

export async function renderLayoutPage(page: PDFPageProxy, signal?: AbortSignal): Promise<{ canvas: Canvas; scale: number }> {
  signal?.throwIfAborted();
  const points = page.getViewport({ scale: 1 });
  if (![points.width, points.height].every((n) => Number.isFinite(n) && n > 0)) throw new Error('잘못된 PDF 페이지 크기');
  const scale = Math.min(3, 2400 / Math.max(points.width, points.height), Math.sqrt(6_000_000 / (points.width * points.height)));
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const task = page.render({ canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D, viewport, background: '#ffffff' });
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]);
  const abort = () => task.cancel();
  bounded.addEventListener('abort', abort, { once: true });
  try { await abortableLayoutWork(task.promise, bounded); bounded.throwIfAborted(); return { canvas, scale }; }
  finally { bounded.removeEventListener('abort', abort); }
}

/** Drawing coverage is deliberately conservative: paths, images, patterns and groups protect text. */
export async function layoutDrawingBounds(page: PDFPageProxy): Promise<{ boxes: Box[]; vectorBoxes: Box[]; uncertain: boolean }> {
  const viewport = page.getViewport({ scale: 1 });
  const list = await page.getOperatorList();
  if (list.fnArray.length > 500_000) throw new Error('페이지 그래픽 연산이 안전 처리 한도를 초과했습니다');
  let m: Matrix = [1, 0, 0, 1, 0, 0];
  let lineWidth = 1;
  let fillWhite = false;
  let clip: Box = [0, 0, viewport.width, viewport.height];
  let pendingClip = false;
  const stack: Array<{ m: Matrix; lineWidth: number; fillWhite: boolean; clip: Box }> = [];
  const boxes: Box[] = [];
  const vectorBoxes: Box[] = [];
  const pending: Box[] = [];
  const pendingStrokes: Box[] = [];
  let uncertain = false;
  const opNames = new Map(Object.entries(OPS).map(([name, value]) => [value, name]));
  const intersectClip = (box: Box) => {
    const x = Math.max(clip[0], box[0]), y = Math.max(clip[1], box[1]);
    clip = [x, y, Math.max(0, Math.min(clip[0] + clip[2], box[0] + box[2]) - x), Math.max(0, Math.min(clip[1] + clip[3], box[1] + box[3]) - y)];
  };
  const consumeClip = () => {
    if (!pendingClip) return;
    pendingClip = false;
    if (!pending.length) { clip = [0, 0, 0, 0]; return; }
    const x = Math.min(...pending.map((box) => box[0])), y = Math.min(...pending.map((box) => box[1]));
    intersectClip([x, y, Math.max(...pending.map((box) => box[0] + box[2])) - x, Math.max(...pending.map((box) => box[1] + box[3])) - y]);
  };
  const add = (box: Box, padding = 0, vector = true) => {
    if (!box.every(Number.isFinite)) { uncertain = true; return; }
    const padded: Box = [box[0] - padding, box[1] - padding, Math.max(0.1, box[2]) + 2 * padding, Math.max(0.1, box[3]) + 2 * padding];
    const x = Math.max(padded[0], clip[0]), y = Math.max(padded[1], clip[1]);
    const clipped: Box = [x, y, Math.min(padded[0] + padded[2], clip[0] + clip[2]) - x, Math.min(padded[1] + padded[3], clip[1] + clip[3]) - y];
    if (clipped[2] <= 0 || clipped[3] <= 0) return;
    boxes.push(clipped);
    if (vector) vectorBoxes.push(clipped);
  };
  for (let i = 0; i < list.fnArray.length; i++) {
    const op = opNames.get(list.fnArray[i]) ?? '';
    const args = list.argsArray[i] as unknown[];
    if (op === 'save') stack.push({ m: [...m], lineWidth, fillWhite, clip });
    else if (op === 'restore') { const saved = stack.pop(); if (saved) { m = saved.m; lineWidth = saved.lineWidth; fillWhite = saved.fillWhite; clip = saved.clip; } else uncertain = true; }
    else if (op === 'transform') m = multiply(m, args as number[]);
    else if (op === 'setLineWidth') lineWidth = Number(args[0]);
    else if (op === 'setFillRGBColor') fillWhite = (args as number[]).every((value) => value >= 250);
    else if (op === 'paintFormXObjectBegin') {
      stack.push({ m: [...m], lineWidth, fillWhite, clip });
      if (Array.isArray(args[0])) m = multiply(m, args[0]);
      const bbox = args[1] as number[] | undefined;
      if (bbox?.length === 4) intersectClip(transformedBox(multiply(viewport.transform, m), ...bbox as [number, number, number, number]));
    } else if (op === 'paintFormXObjectEnd' || op === 'endGroup') { const saved = stack.pop(); if (saved) { m = saved.m; lineWidth = saved.lineWidth; fillWhite = saved.fillWhite; clip = saved.clip; } else uncertain = true; }
    else if (op === 'beginGroup') {
      stack.push({ m: [...m], lineWidth, fillWhite, clip });
      const group = args[0] as { matrix?: number[]; bbox?: number[] };
      if (group.bbox?.length === 4) {
        const matrix = group.matrix ? multiply(m, group.matrix) : m;
        const bounds = transformedBox(multiply(viewport.transform, matrix), ...group.bbox as [number, number, number, number]);
        add(bounds, 1);
        intersectClip(bounds);
      } else uncertain = true;
    } else if (op === 'clip' || op === 'eoClip') pendingClip = true;
    else if (op === 'constructPath') {
      const bounds = args[2] as number[] | undefined;
      if (!bounds || bounds.length !== 4) uncertain = true;
      else pending.push(transformedBox(multiply(viewport.transform, m), ...bounds as [number, number, number, number]));
      // Grid borders sharing one PDF path are individual strokes, not a filled table bbox.
      const pathOps = args[0] as number[], coordinates = args[1] as number[];
      const tx = multiply(viewport.transform, m);
      let x = 0, y = 0, startX = 0, startY = 0, at = 0;
      for (const code of pathOps) {
        if (code === OPS.moveTo) { x = startX = coordinates[at++]; y = startY = coordinates[at++]; }
        else if (code === OPS.lineTo) {
          const nx = coordinates[at++], ny = coordinates[at++];
          pendingStrokes.push(transformedBox(tx, Math.min(x, nx), Math.min(y, ny), Math.max(x, nx), Math.max(y, ny)));
          x = nx; y = ny;
        } else if (code === OPS.rectangle) {
          const left = coordinates[at++], bottom = coordinates[at++], w = coordinates[at++], h = coordinates[at++];
          for (const [a, b, c, d] of [[left, bottom, left + w, bottom], [left + w, bottom, left + w, bottom + h], [left, bottom + h, left + w, bottom + h], [left, bottom, left, bottom + h]]) pendingStrokes.push(transformedBox(tx, Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)));
          x = startX = left; y = startY = bottom;
        } else if (code === OPS.closePath) {
          pendingStrokes.push(transformedBox(tx, Math.min(x, startX), Math.min(y, startY), Math.max(x, startX), Math.max(y, startY)));
          x = startX; y = startY;
        } else if (code === OPS.curveTo || code === OPS.curveTo2 || code === OPS.curveTo3) {
          const count = code === OPS.curveTo ? 6 : 4;
          const values = coordinates.slice(at, at + count);
          at += count;
          const xs = [x, ...values.filter((_, index) => index % 2 === 0)], ys = [y, ...values.filter((_, index) => index % 2 === 1)];
          pendingStrokes.push(transformedBox(tx, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)));
          x = values[count - 2]; y = values[count - 1];
        } else uncertain = true;
      }
    } else if (['stroke', 'closeStroke', 'fill', 'eoFill', 'fillStroke', 'eoFillStroke', 'closeFillStroke', 'closeEOFillStroke'].includes(op)) {
      const padding = Math.max(1, Math.abs(lineWidth) * Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3])) / 2);
      if (!fillWhite && /fill/i.test(op)) for (const box of pending) add(box, 1);
      if (/stroke/i.test(op)) for (const box of pendingStrokes) add(box, padding);
      consumeClip();
      pending.length = 0;
      pendingStrokes.length = 0;
    } else if (op === 'endPath') { consumeClip(); pending.length = 0; pendingStrokes.length = 0; }
    else if (['paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'paintSolidColorImageMask'].includes(op)) add(transformedBox(multiply(viewport.transform, m), 0, 0, 1, 1), 1, false);
    else if (op === 'shadingFill') add(clip);
    else if (op === 'setFillColorN') fillWhite = false;
    else if (['paintImageXObjectRepeat', 'paintImageMaskXObjectRepeat', 'paintImageMaskXObjectGroup', 'paintInlineImageXObjectGroup'].includes(op)) add(clip);
    else if (op === 'setGState' && Array.isArray(args[0])) {
      for (const [key, value] of args[0] as unknown[][]) if (key === 'LW' && typeof value === 'number') lineWidth = value;
    }
    if (boxes.length > 100_000) throw new Error('페이지 그래픽 영역이 안전 처리 한도를 초과했습니다');
  }
  return { boxes, vectorBoxes, uncertain };
}

/** Join only verified inline runs; table dividers, equations and column gaps remain separate. */
export async function extractLayoutPage(page: PDFPageProxy, worker: LayoutOcrWorker | null, signal: AbortSignal): Promise<LayoutTranslationPage> {
  signal.throwIfAborted();
  const viewport = page.getViewport({ scale: 1 });
  const content = await abortableLayoutWork(page.getTextContent({ disableNormalization: true }), signal);
  let regions: LayoutTranslationRegion[] = [];
  const nativeMetrics = new Map<string, { font: string; baseline: number }>();
  let sourceChars = 0;
  for (let i = 0; i < content.items.length; i++) {
    const item = content.items[i];
    if (!('str' in item) || !item.str.trim()) continue;
    sourceChars += item.str.length;
    if (sourceChars > MAX_PAGE_CHARS) throw new Error('페이지 원문이 100,000자 한도를 초과했습니다');
    if (regions.length >= MAX_REGIONS) throw new Error('페이지 텍스트 영역이 12,000개 한도를 초과했습니다');
    const region = nativeRegion(item, content.styles[item.fontName], viewport, `p${page.pageNumber}-pdf-${i}`);
    if (!region.box.every((value) => Number.isFinite(value) && Math.abs(value) <= 200_000) || region.fontSize <= 0 || region.box[2] <= 0 || region.box[3] <= 0) throw new Error('PDF 텍스트 좌표가 올바르지 않습니다');
    regions.push(region);
    nativeMetrics.set(region.id, { font: item.fontName, baseline: multiply(viewport.transform, item.transform)[5] });
  }
  signal.throwIfAborted();
  const drawings = await abortableLayoutWork(layoutDrawingBounds(page), signal);
  const raster = await renderLayoutPage(page, signal);
  const pixels = raster.canvas.getContext('2d').getImageData(0, 0, raster.canvas.width, raster.canvas.height).data;
  let separatedRuns = 0;
  const joinedNative: LayoutTranslationRegion[] = [];
  for (const region of regions) {
    const previous = joinedNative[joinedNative.length - 1];
    const a = previous ? nativeMetrics.get(previous.id)! : null, b = nativeMetrics.get(region.id)!;
    const sameLine = previous && a?.font === b.font && Math.abs(a.baseline - b.baseline) <= region.fontSize * 0.08 && Math.abs(previous.fontSize - region.fontSize) <= region.fontSize * 0.02 && Math.abs(previous.rotation) < 0.01 && Math.abs(region.rotation) < 0.01;
    if (sameLine && previous.kind === 'text' && region.kind === 'text' && !/[=^_{}\u0370-\u03ff\u2190-\u22ff]/u.test(previous.source + region.source)) {
      const box = inlineUnionBox(previous.box, region.box, region.fontSize, drawings.vectorBoxes);
      if (box && !inlineRasterDivider(pixels, raster.canvas.width, raster.canvas.height, previous.box, region.box, raster.scale, region.fontSize) && previous.source.length + region.source.length < 10_000) {
        const gap = region.box[0] - previous.box[0] - previous.box[2] + 2;
        previous.source += /\s$/u.test(previous.source) || /^\s/u.test(region.source) || gap <= region.fontSize * 0.12 ? region.source : ` ${region.source}`;
        previous.box = box;
        previous.safe &&= region.safe;
        if (!previous.safe && !previous.reason) previous.reason = region.reason;
        continue;
      }
      separatedRuns++;
    }
    joinedNative.push(region);
  }
  regions = joinedNative;
  refineNativeBoxes(regions, { data: pixels, width: raster.canvas.width, height: raster.canvas.height, scale: raster.scale });
  // Spatial buckets bound the native-overlap search for ordinary pages, without dropping neighbors.
  const buckets = new Map<string, number[]>();
  const candidates = (box: Box) => {
    const keys: string[] = [];
    for (let y = Math.floor(box[1] / 64); y <= Math.floor((box[1] + box[3]) / 64); y++) for (let x = Math.floor(box[0] / 64); x <= Math.floor((box[0] + box[2]) / 64); x++) {
      if (keys.length >= 100_000) throw new Error('PDF 텍스트 영역 크기가 안전 한도를 초과했습니다');
      keys.push(`${x},${y}`);
    }
    return keys;
  };
  for (let i = 0; i < regions.length; i++) for (const key of candidates(regions[i].box)) { const bucket = buckets.get(key) ?? []; bucket.push(i); buckets.set(key, bucket); }
  let drawingChecks = 0;
  for (let i = 0; i < regions.length; i++) {
    signal.throwIfAborted();
    const region = regions[i];
    if (!region.safe) continue;
    let reason: string | undefined;
    const neighbors = new Set(candidates(region.box).flatMap((key) => buckets.get(key) ?? []));
    if ([...neighbors].some((j) => i !== j && overlaps(region.box, regions[j].box))) reason = '다른 원문 텍스트·수식과 겹쳐 원문 보존';
    else if (drawings.uncertain || drawings.boxes.some((box) => ++drawingChecks > 2_000_000 || overlaps(region.box, box))) reason = '표 선·도형·이미지와 겹치거나 그래픽 안전성을 입증할 수 없어 원문 보존';
    else if (!plainRaster(pixels, raster.canvas.width, raster.canvas.height, region.box, raster.scale, region.fontSize)) reason = '흰 배경·여백 또는 비텍스트 선 안전 검사를 통과하지 못해 원문 보존';
    if (reason) { region.safe = false; region.reason = reason; }
  }
  const warnings: string[] = [];
  if (separatedRuns) warnings.push(`${separatedRuns}개 인접 텍스트 조각은 표·열 간격 또는 구분 선 때문에 합치지 않고 원문 단위를 유지합니다.`);
  if (worker) {
    signal.throwIfAborted();
    // Recognition-only contrast normalization removes flat colored label backgrounds.
    // All erasure decisions below still inspect the untouched original page pixels.
    const recognitionCanvas = createCanvas(raster.canvas.width, raster.canvas.height);
    const recognitionContext = recognitionCanvas.getContext('2d');
    const recognitionPixels = recognitionContext.createImageData(recognitionCanvas.width, recognitionCanvas.height);
    for (let i = 0; i < pixels.length; i += 4) {
      const value = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2] < 160 ? 0 : 255;
      recognitionPixels.data[i] = recognitionPixels.data[i + 1] = recognitionPixels.data[i + 2] = value;
      recognitionPixels.data[i + 3] = 255;
    }
    recognitionContext.putImageData(recognitionPixels, 0, 0);
    const { data } = await abortableLayoutWork(worker.recognize(recognitionCanvas.toBuffer('image/png')), AbortSignal.any([signal, AbortSignal.timeout(120_000)]));
    signal.throwIfAborted();
    type OcrRun = { text: string; box: Box; fontSize: number; confidence: number; rotation: number; symbols: Array<{ text: string; confidence: number; box: Box }> };
    const runs: OcrRun[] = [];
    let words = 0;
    for (const block of data.blocks ?? []) for (const paragraph of block.paragraphs) for (const line of paragraph.lines) {
      let previous: OcrRun | null = null;
      for (const word of line.words) {
        const text = word.text.trim();
        if (!text) continue;
        if (++words > MAX_REGIONS) throw new Error('페이지 OCR 단어가 12,000개 한도를 초과했습니다');
        const tight: Box = [word.bbox.x0 / raster.scale, word.bbox.y0 / raster.scale, (word.bbox.x1 - word.bbox.x0) / raster.scale, (word.bbox.y1 - word.bbox.y0) / raster.scale];
        if (!tight.every(Number.isFinite) || tight[2] <= 0 || tight[3] <= 0) { previous = null; continue; }
        const nativeNeighbors = new Set(candidates(tight).flatMap((key) => buckets.get(key) ?? []));
        if (duplicatesNative(tight, [...nativeNeighbors].map((i) => regions[i]))) { previous = null; continue; }
        sourceChars += text.length;
        if (sourceChars > MAX_PAGE_CHARS) throw new Error('페이지 원문이 100,000자 한도를 초과했습니다');
        const box: Box = [tight[0] - 2, tight[1] - 2, tight[2] + 4, tight[3] + 4];
        const symbols = word.symbols.map((symbol) => ({ text: symbol.text, confidence: symbol.confidence, box: [symbol.bbox.x0 / raster.scale, symbol.bbox.y0 / raster.scale, (symbol.bbox.x1 - symbol.bbox.x0) / raster.scale, (symbol.bbox.y1 - symbol.bbox.y0) / raster.scale] as Box }));
        const rotation = Math.atan2(line.baseline.y1 - line.baseline.y0, line.baseline.x1 - line.baseline.x0) * 180 / Math.PI;
        const join = previous && Math.abs(rotation) < 0.5 && !/[=^_{}\u0370-\u03ff\u2190-\u22ff]/u.test(previous.text + text) && Math.max(previous.fontSize, tight[3]) <= Math.min(previous.fontSize, tight[3]) * 1.8 ? inlineUnionBox(previous.box, box, Math.max(previous.fontSize, tight[3]), drawings.vectorBoxes, 2) : null;
        if (previous && join && !inlineRasterDivider(pixels, raster.canvas.width, raster.canvas.height, previous.box, box, raster.scale, Math.max(previous.fontSize, tight[3])) && previous.text.length + text.length < 10_000) {
          previous.text += ` ${text}`;
          previous.box = join;
          previous.fontSize = Math.max(previous.fontSize, tight[3]);
          previous.confidence = Math.min(previous.confidence, word.confidence);
          previous.symbols.push(...symbols);
        } else {
          previous = { text, box, fontSize: tight[3], confidence: word.confidence, rotation, symbols };
          runs.push(previous);
        }
      }
    }
    for (const [index, run] of runs.entries()) {
      if (regions.length >= MAX_REGIONS) throw new Error('페이지 OCR 영역이 12,000개 한도를 초과했습니다');
      const kind = protectedSource(run.text) ? 'protected' : 'text';
      const safe = kind === 'text' && run.confidence >= 90 && Math.abs(run.rotation) < 0.5 && !drawings.uncertain && !drawings.vectorBoxes.some((drawing) => ++drawingChecks > 2_000_000 || overlaps(run.box, drawing)) && ocrGlyphRaster(pixels, raster.canvas.width, raster.canvas.height, run.box, raster.scale, run.fontSize, run.symbols);
      regions.push({ id: `p${page.pageNumber}-ocr-${index}`, source: run.text, ko: null, box: run.box, fontSize: run.fontSize, rotation: Math.abs(run.rotation) < 0.5 ? 0 : run.rotation, origin: 'ocr', kind, confidence: Math.max(0, Math.min(1, run.confidence / 100)), safe, ...(!safe ? { reason: kind === 'protected' ? '수식·숫자·기호 원문 보존' : 'OCR 신뢰도·흰 여백·글자 픽셀 또는 표·그림 선 안전 검사를 통과하지 못해 원문 보존' } : {}) });
    }
    warnings.push('OCR은 로컬 영어 인식입니다. 숫자·기호·회전 글자 및 저해상도 원문은 오인식될 수 있습니다. 안전 검사를 통과한 흰 배경 글자만 교체하며 나머지는 별도 한국어 목록으로 제공합니다.');
  }
  // Re-evaluate all neighbors after OCR adds regions; never erase another label.
  const allBuckets = new Map<string, number[]>();
  for (let i = 0; i < regions.length; i++) for (const key of candidates(regions[i].box)) { const bucket = allBuckets.get(key) ?? []; bucket.push(i); allBuckets.set(key, bucket); }
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];
    if (!region.safe) continue;
    const neighbors = new Set(candidates(region.box).flatMap((key) => allBuckets.get(key) ?? []));
    if ([...neighbors].some((j) => i !== j && overlaps(region.box, regions[j].box))) { region.safe = false; region.reason = '다른 글자·수식 영역과 겹쳐 원문 보존'; }
  }
  if (regions.reduce((n, region) => n + region.source.length, 0) > MAX_PAGE_CHARS) throw new Error('페이지 원문이 100,000자 한도를 초과했습니다');
  const unsafe = regions.filter((region) => region.kind === 'text' && !region.safe).length;
  if (unsafe) warnings.push(`${unsafe}개 텍스트 영역은 원문 손상 위험으로 지우지 않으며 한국어는 별도 목록으로 제공합니다.`);
  if (!regions.length) warnings.push(worker ? '이 페이지에서 텍스트를 인식하지 못했습니다.' : '추출 가능한 PDF 텍스트가 없습니다. 스캔·그림 속 글자는 로컬 OCR을 켜세요.');
  return { page: page.pageNumber, width: viewport.width, height: viewport.height, regions, warnings };
}

/** All OCR resources are explicit local files: no CDN or language-data download. */
export async function createLayoutOcr(signal: AbortSignal): Promise<LayoutOcrWorker> {
  signal.throwIfAborted();
  const localPath = (path: string) => {
    const unpacked = path.replace(/([/\\])app\.asar([/\\])/g, '$1app.asar.unpacked$2');
    return unpacked !== path && existsSync(unpacked) ? unpacked : path;
  };
  const workerPath = localPath(join(dirname(require.resolve('tesseract.js/package.json')), 'src/worker-script/node/index.js'));
  const corePath = localPath(dirname(require.resolve('tesseract.js-core/package.json')));
  const langPath = localPath(join(dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0'));
  const entry = localPath(require.resolve('tesseract.js'));
  await Promise.all([stat(workerPath), stat(join(langPath, 'eng.traineddata.gz')), stat(corePath), stat(entry)]);
  signal.throwIfAborted();
  // An owning thread makes Tesseract startup cancellable as well as recognition.
  // This is trusted application code; document text is only ever worker message data.
  const bootstrap = `
    import { parentPort, workerData } from 'node:worker_threads';
    import { createRequire } from 'node:module';
    const require = createRequire(workerData.entry);
    const { createWorker, PSM } = require(workerData.entry);
    try {
      const worker = await createWorker('eng', 1, {
        workerPath: workerData.workerPath, corePath: workerData.corePath,
        langPath: workerData.langPath, gzip: true, cacheMethod: 'none',
        errorHandler(error) { parentPort.postMessage({ error: String(error) }); }
      });
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, preserve_interword_spaces: '1' });
      parentPort.on('message', async ({ id, image }) => {
        try {
          const { data } = await worker.recognize(Buffer.from(image), {}, { blocks: true, text: false });
          parentPort.postMessage({ id, data: { blocks: data.blocks } });
        } catch (error) { parentPort.postMessage({ id, error: String(error) }); }
      });
      parentPort.postMessage({ ready: true });
    } catch (error) { parentPort.postMessage({ error: String(error) }); }
  `;
  const thread = new NodeWorker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), { workerData: { entry, workerPath, corePath, langPath } });
  const ready = Promise.withResolvers<void>();
  const pending = new Map<number, { resolve(value: { data: Pick<OcrPage, 'blocks'> }): void; reject(error: Error): void }>();
  let next = 0;
  let stopped = false;
  const fail = (error: Error) => {
    ready.reject(error);
    for (const work of pending.values()) work.reject(error);
    pending.clear();
  };
  thread.on('message', (message: { ready?: boolean; id?: number; error?: string; data?: Pick<OcrPage, 'blocks'> }) => {
    if (message.error) {
      const error = new Error(`로컬 OCR 처리 실패: ${message.error}`);
      if (message.id !== undefined) { pending.get(message.id)?.reject(error); pending.delete(message.id); }
      else fail(error);
    } else if (message.ready) ready.resolve();
    else if (message.id !== undefined && message.data) { pending.get(message.id)?.resolve({ data: message.data }); pending.delete(message.id); }
  });
  thread.on('error', (error) => fail(new Error(`로컬 OCR 작업자 오류: ${error instanceof Error ? error.message : String(error)}`)));
  thread.on('exit', (code) => { if (!stopped) fail(new Error(`로컬 OCR 작업자가 종료되었습니다 (${code})`)); });
  const terminate = async () => {
    if (stopped) return;
    stopped = true;
    fail(new Error('로컬 OCR 처리가 중단되었습니다'));
    await thread.terminate();
  };
  const abort = () => { void terminate(); };
  signal.addEventListener('abort', abort, { once: true });
  try { await abortableLayoutWork(ready.promise, AbortSignal.any([signal, AbortSignal.timeout(60_000)])); }
  catch (error) { signal.removeEventListener('abort', abort); await terminate(); throw error; }
  return {
    async recognize(image) {
      if (stopped) throw new Error('로컬 OCR 작업자가 중단되었습니다');
      const id = next++;
      const result = Promise.withResolvers<{ data: Pick<OcrPage, 'blocks'> }>();
      pending.set(id, result);
      try {
        thread.postMessage({ id, image });
        return await abortableLayoutWork(result.promise, AbortSignal.any([signal, AbortSignal.timeout(120_000)]));
      } catch (error) { await terminate(); throw error; }
      finally { pending.delete(id); }
    },
    async terminate() { signal.removeEventListener('abort', abort); await terminate(); },
  };
}
