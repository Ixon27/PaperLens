import { PDFDocument } from 'pdf-lib';
import { fitLayoutText, layoutBoxWithinPage, layoutBoxesOverlap, type LayoutBox } from '../../shared/layout-fit';
import type { LayoutTranslationPage } from '../../shared/layout-translation';

export const LAYOUT_FONT_FAMILY = '"PaperLens Noto Sans KR", "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';

export interface LayoutPlacement {
  id: string;
  status: 'translated' | 'overflow' | 'unsafe' | 'untranslated' | 'protected';
  source: string;
  ko: string | null;
  box: LayoutBox;
  fontSize?: number;
  lines?: string[];
  reason?: string;
}

export interface LayoutRenderOptions {
  fontFamily?: string;
  minFontSize?: number;
  maxFontSize?: number;
  padding?: number;
  signal?: AbortSignal;
}

export interface LayoutRenderResult {
  canvas: HTMLCanvasElement;
  placements: LayoutPlacement[];
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('원문 배치 번역 렌더링을 취소했습니다.', 'AbortError');
}

async function loadLayoutFont(fontFamily = LAYOUT_FONT_FAMILY): Promise<void> {
  // ready alone does not start loading an @font-face which has not yet been used.
  const faces = await document.fonts.load(`12px ${fontFamily}`, '한글 번역');
  await document.fonts.ready;
  if (fontFamily === LAYOUT_FONT_FAMILY && !faces.length) {
    throw new Error('내장 한국어 글꼴을 불러오지 못했습니다. 원본 페이지는 변경되지 않았습니다.');
  }
}

/** Conservative, deterministic raster guard, also usable by browser/native-canvas smoke checks. */
export function inspectLayoutRegionPixels(
  image: Pick<ImageData, 'data' | 'width' | 'height'>,
  fontSizePx = 0,
): string | null {
  const { data, width, height } = image;
  if (width < 3 || height < 3 || data.length !== width * height * 4) return '안전하게 지우기에는 영역이 너무 작습니다.';
  const white = (index: number) => data[index + 3] >= 250
    && data[index] >= 245 && data[index + 1] >= 245 && data[index + 2] >= 245;
  const dark = (index: number) => data[index + 3] > 128
    && Math.min(data[index], data[index + 1], data[index + 2]) < 180;
  for (let x = 0; x < width; x++) {
    if (!white(x * 4) || !white(((height - 1) * width + x) * 4)) return '영역 가장자리가 흰색이 아니므로 배경이나 인접 내용을 보존합니다.';
  }
  for (let y = 0; y < height; y++) {
    if (!white(y * width * 4) || !white((y * width + width - 1) * 4)) return '영역 가장자리가 흰색이 아니므로 배경이나 인접 내용을 보존합니다.';
  }
  let darkPixels = 0;
  // A tall Latin l/I stem can occupy nearly the entire tight OCR box. A rule must
  // also exceed plausible glyph height; engine safety proof still protects short graph strokes.
  const glyphStrokeLimit = Number.isFinite(fontSizePx) ? Math.max(0, fontSizePx) * 1.8 : 0;
  const horizontalLimit = Math.max(12, Math.ceil(width * 0.8), Math.ceil(glyphStrokeLimit));
  const verticalLimit = Math.max(12, Math.ceil(height * 0.8), Math.ceil(glyphStrokeLimit));
  for (let y = 1; y < height - 1; y++) {
    let run = 0;
    for (let x = 1; x < width - 1; x++) {
      if (dark((y * width + x) * 4)) { darkPixels++; run++; } else run = 0;
      if (run >= horizontalLimit) return '영역을 가로지르는 수평 표 선이나 그림을 보존합니다.';
    }
  }
  for (let x = 1; x < width - 1; x++) {
    let run = 0;
    for (let y = 1; y < height - 1; y++) {
      run = dark((y * width + x) * 4) ? run + 1 : 0;
      if (run >= verticalLimit) return '영역을 가로지르는 수직 표 선이나 그림을 보존합니다.';
    }
  }
  if (darkPixels / (width * height) > 0.45) return '내용이 조밀하여 글자와 그림을 안전하게 구분할 수 없습니다.';
  return null;
}

/**
 * Composes a new canvas. The supplied source canvas and translation data are never changed.
 * Unsupported regions stay pixel-identical; their complete Korean remains in placements.
 */
export async function renderLayoutPage(
  originalCanvas: HTMLCanvasElement,
  page: LayoutTranslationPage,
  options: LayoutRenderOptions = {},
): Promise<LayoutRenderResult> {
  checkCancelled(options.signal);
  if (!Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0
    || !originalCanvas.width || !originalCanvas.height) throw new Error('원본 페이지 크기가 올바르지 않습니다.');
  const scaleX = originalCanvas.width / page.width;
  const scaleY = originalCanvas.height / page.height;
  if (Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY) > 0.01) {
    throw new Error('원본 이미지의 방향이나 가로세로 비율이 번역 PDF 페이지와 다릅니다.');
  }
  await loadLayoutFont(options.fontFamily);
  checkCancelled(options.signal);
  const canvas = document.createElement('canvas');
  canvas.width = originalCanvas.width;
  canvas.height = originalCanvas.height;
  const context = canvas.getContext('2d');
  const source = originalCanvas.getContext('2d', { willReadFrequently: true });
  if (!context || !source) throw new Error('원문 배치 번역에 필요한 2차원 캔버스를 사용할 수 없습니다.');
  context.drawImage(originalCanvas, 0, 0);
  context.textBaseline = 'alphabetic';
  context.textAlign = 'left';
  context.direction = 'ltr';
  const placements: LayoutPlacement[] = [];
  for (let index = 0; index < page.regions.length; index++) {
    if (index % 12 === 0) {
      const pause = Promise.withResolvers<void>();
      setTimeout(pause.resolve, 0);
      await pause.promise;
      checkCancelled(options.signal);
    }
    const region = page.regions[index];
    const placement: LayoutPlacement = {
      id: region.id, source: region.source, ko: region.ko, box: [...region.box], status: 'untranslated',
    };
    placements.push(placement);
    if (region.kind === 'protected') {
      placement.status = 'protected';
      placement.reason = region.reason ?? '수식, 그림 또는 보호된 원문을 그대로 보존합니다.';
      continue;
    }
    if (!region.ko?.trim()) { placement.reason = '한국어 번역이 아직 없습니다.'; continue; }
    const unsafe = !region.safe ? region.reason ?? '원문을 지워도 안전한지 확인할 수 없어 보존합니다.'
      : !Number.isFinite(region.rotation) || Math.abs(region.rotation) > 0.01 ? '회전된 글자의 교체를 지원하지 않아 원문을 보존합니다.'
      : !layoutBoxWithinPage(region.box, page.width, page.height) ? '영역이 페이지 밖에 있거나 좌표가 올바르지 않습니다.'
      : page.regions.some((other, otherIndex) => otherIndex !== index && layoutBoxesOverlap(region.box, other.box))
        ? '다른 원문 영역과 겹쳐서 두 영역의 원문을 모두 보존합니다.' : null;
    if (unsafe) { placement.status = 'unsafe'; placement.reason = unsafe; continue; }
    // Whole-pixel bounds INSIDE the source box ensure no outside pixel is ever painted.
    const left = Math.ceil(region.box[0] * scaleX);
    const top = Math.ceil(region.box[1] * scaleY);
    const right = Math.floor((region.box[0] + region.box[2]) * scaleX);
    const bottom = Math.floor((region.box[1] + region.box[3]) * scaleY);
    if (right - left < 3 || bottom - top < 3) {
      placement.status = 'unsafe'; placement.reason = '현재 이미지 해상도에서 이 영역이 너무 작아 원문을 보존합니다.'; continue;
    }
    let rasterReason: string | null;
    try {
      rasterReason = inspectLayoutRegionPixels(
        source.getImageData(left, top, right - left, bottom - top),
        region.fontSize * Math.max(scaleX, scaleY),
      );
    } catch {
      rasterReason = '원본 픽셀을 확인할 수 없어 원문을 보존합니다.';
    }
    if (rasterReason) { placement.status = 'unsafe'; placement.reason = rasterReason; continue; }
    const paintBox: LayoutBox = [left / scaleX, top / scaleY, (right - left) / scaleX, (bottom - top) / scaleY];
    const fitted = fitLayoutText({
      text: region.ko, box: paintBox, fontSize: region.fontSize,
      minFontSize: options.minFontSize, maxFontSize: options.maxFontSize, padding: options.padding,
      measure: (text, fontSize) => {
        context.font = `${fontSize}px ${options.fontFamily ?? LAYOUT_FONT_FAMILY}`;
        return context.measureText(text);
      },
    });
    if (!fitted.fits) { placement.status = 'overflow'; placement.reason = fitted.reason; continue; }
    context.save();
    // The clip is a pixel preservation fence, not a substitute for text fitting.
    context.beginPath(); context.rect(left, top, right - left, bottom - top); context.clip();
    context.fillStyle = '#fff'; context.fillRect(left, top, right - left, bottom - top);
    context.scale(scaleX, scaleY);
    context.fillStyle = '#111';
    context.font = `${fitted.fontSize}px ${options.fontFamily ?? LAYOUT_FONT_FAMILY}`;
    for (const line of fitted.lines) context.fillText(line.text, line.x, line.baseline);
    context.restore();
    placement.status = 'translated';
    placement.fontSize = fitted.fontSize;
    placement.lines = fitted.lines.map((line) => line.text);
  }
  checkCancelled(options.signal);
  return { canvas, placements };
}

export interface LayoutPdfExportOptions {
  pages: LayoutTranslationPage[];
  /** Supply high-resolution original-page rendering/composition (normally 2x points or higher). */
  renderPage: (page: LayoutTranslationPage) => Promise<LayoutRenderResult>;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
  /** Defaults to true. Includes full source and Korean for every preserved translated region. */
  includeOverflowAppendix?: boolean;
}

async function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const { promise, resolve, reject } = Promise.withResolvers<Blob>();
  canvas.toBlob(
    (value) => value ? resolve(value) : reject(new Error('렌더링한 페이지를 PNG 이미지로 변환하지 못했습니다.')), 'image/png',
  );
  const blob = await promise;
  return new Uint8Array(await blob.arrayBuffer());
}

/** Raster-only PDF: accurate visual layout, deliberately not a searchable text-layer export. */
export async function exportLayoutPdf(options: LayoutPdfExportOptions): Promise<Blob> {
  if (!options.pages.length) throw new Error('내보낼 번역 페이지가 없습니다.');
  checkCancelled(options.signal);
  await loadLayoutFont();
  const pdf = await PDFDocument.create();
  pdf.setTitle('한국어 원문 배치 번역 (이미지 PDF)');
  pdf.setSubject('검색할 수 없는 이미지 PDF입니다. 보존 영역의 전체 번역은 부록에 포함됩니다.');
  const preserved: Array<{ page: number; placement: LayoutPlacement }> = [];
  for (let index = 0; index < options.pages.length; index++) {
    checkCancelled(options.signal);
    const page = options.pages[index];
    if (!Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0) {
      throw new Error(`${page.page}페이지의 내보내기 크기가 올바르지 않습니다.`);
    }
    const rendered = await options.renderPage(page);
    checkCancelled(options.signal);
    const image = await pdf.embedPng(await canvasPng(rendered.canvas));
    const output = pdf.addPage([page.width, page.height]);
    output.drawImage(image, { x: 0, y: 0, width: page.width, height: page.height });
    for (const placement of rendered.placements) {
      if (placement.status !== 'translated' && placement.ko?.trim()) preserved.push({ page: page.page, placement });
    }
    // Release each page's PNG immediately rather than retaining every high-resolution canvas.
    options.onProgress?.(index + 1, options.pages.length);
  }
  if (options.includeOverflowAppendix !== false && preserved.length) {
    // The appendix is rasterized with the same bundled Korean font, avoiding lossy ASCII PDF fonts.
    const width = 595.28, height = 841.89, margin = 36, fontSize = 10, lineHeight = 15;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * 2); canvas.height = Math.ceil(height * 2);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('한국어 번역 부록에 필요한 2차원 캔버스를 사용할 수 없습니다.');
    let baseline = margin + 12;
    let appendixNumber = 0;
    const beginPage = () => {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.scale(2, 2);
      context.fillStyle = '#111'; context.textBaseline = 'alphabetic';
      context.textAlign = 'left'; context.direction = 'ltr';
      context.font = `12px ${LAYOUT_FONT_FAMILY}`;
      context.fillText(`보존 영역 전체 번역 · ${++appendixNumber}`, margin, margin + 12);
      context.font = `${fontSize}px ${LAYOUT_FONT_FAMILY}`;
      baseline = margin + 38;
    };
    const flush = async () => {
      checkCancelled(options.signal);
      const image = await pdf.embedPng(await canvasPng(canvas));
      pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
    };
    beginPage();
    const segments = new Intl.Segmenter('ko', { granularity: 'grapheme' });
    const drawLine = async (line: string) => {
      if (baseline + 4 > height - margin) { await flush(); beginPage(); }
      context.fillText(line, margin, baseline);
      baseline += lineHeight;
    };
    for (const { page, placement } of preserved) {
      checkCancelled(options.signal);
      const statusLabel = { translated: '번역됨', overflow: '공간 부족', unsafe: '안전 보존', untranslated: '미번역', protected: '보호 영역' }[placement.status];
      const text = `페이지 ${page} · 영역 ${placement.id} · ${statusLabel}\n${placement.reason ?? ''}\n원문: ${placement.source}\n한국어: ${placement.ko}\n`;
      let line = '';
      let count = 0;
      for (const part of segments.segment(text.replace(/\r\n?/g, '\n'))) {
        if (++count % 2048 === 0) {
          const pause = Promise.withResolvers<void>();
          setTimeout(pause.resolve, 0);
          await pause.promise;
          checkCancelled(options.signal);
        }
        if (part.segment === '\n') { await drawLine(line); line = ''; continue; }
        if (context.measureText(line + part.segment).width > width - margin * 2 && line) {
          await drawLine(line); line = '';
        }
        line += part.segment;
      }
      if (line) await drawLine(line);
      await drawLine('');
    }
    await flush();
  }
  checkCancelled(options.signal);
  const bytes = await pdf.save();
  checkCancelled(options.signal);
  return new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
}
