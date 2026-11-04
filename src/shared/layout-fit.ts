export type LayoutBox = [number, number, number, number];

export interface LayoutTextMetrics {
  width: number;
  actualBoundingBoxLeft?: number;
  actualBoundingBoxRight?: number;
  actualBoundingBoxAscent?: number;
  actualBoundingBoxDescent?: number;
}

export interface LayoutFitOptions {
  text: string;
  box: LayoutBox;
  fontSize: number;
  minFontSize?: number;
  maxFontSize?: number;
  padding?: number;
  measure: (text: string, fontSize: number) => LayoutTextMetrics;
}

export interface LayoutFittedLine {
  text: string;
  x: number;
  baseline: number;
  width: number;
}

export type LayoutFitResult = {
  fits: true;
  fontSize: number;
  lineHeight: number;
  lines: LayoutFittedLine[];
} | { fits: false; reason: string };

const graphemes = new Intl.Segmenter('ko', { granularity: 'grapheme' });

export function validLayoutBox(box: LayoutBox): boolean {
  return box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0;
}

/** Touching edges are not intersections: painting is restricted to each box's interior. */
export function layoutBoxesOverlap(a: LayoutBox, b: LayoutBox): boolean {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2]
    && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

export function layoutBoxWithinPage(box: LayoutBox, width: number, height: number): boolean {
  return validLayoutBox(box) && Number.isFinite(width) && Number.isFinite(height)
    && box[0] >= 0 && box[1] >= 0 && box[0] + box[2] <= width && box[1] + box[3] <= height;
}

function inkWidth(metrics: LayoutTextMetrics): number {
  return Math.max(metrics.width, metrics.actualBoundingBoxRight ?? metrics.width)
    + Math.max(0, metrics.actualBoundingBoxLeft ?? 0);
}

/** Pure, deterministic geometry; the caller supplies real font measurements in page points. */
export function fitLayoutText(options: LayoutFitOptions): LayoutFitResult {
  const { text, box, measure } = options;
  const minimum = Math.max(7, options.minFontSize ?? 7);
  const maximum = Math.min(options.maxFontSize ?? Math.max(minimum, options.fontSize), box[3]);
  const padding = options.padding ?? 0.75;
  if (!validLayoutBox(box) || !Number.isFinite(padding) || padding < 0
    || !Number.isFinite(options.fontSize) || (options.maxFontSize !== undefined && !Number.isFinite(options.maxFontSize))
    || !Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum < minimum) {
    return { fits: false, reason: '번역 영역 또는 글자 크기 설정이 올바르지 않습니다.' };
  }
  if (!text.trim()) return { fits: false, reason: '표시할 한국어 번역이 없습니다.' };
  const width = box[2] - padding * 2;
  const height = box[3] - padding * 2;
  if (width <= 0 || height <= 0) return { fits: false, reason: '영역 안에 읽을 수 있는 번역을 배치할 공간이 없습니다.' };
  const characters = Array.from(graphemes.segment(text.replace(/\r\n?/g, '\n')), (part) => part.segment);
  // Quarter-point steps are stable across platforms and always try the exact minimum.
  const steps = Math.ceil((maximum - minimum) * 4);
  for (let step = 0; step <= steps; step++) {
    const fontSize = Math.max(minimum, maximum - step / 4);
    // Wrap using an optimistic line count; actual glyph extents determine final geometry below.
    let lineHeight = fontSize * 1.25;
    const maxLines = Math.floor((height - fontSize) / lineHeight) + 1;
    if (maxLines < 1) continue;
    const lines: string[] = [];
    let current = '';
    let failed = false;
    for (const character of characters) {
      if (character === '\n') {
        lines.push(current);
        current = '';
      } else {
        const candidate = current + character;
        const metrics = measure(candidate, fontSize);
        const measured = inkWidth(metrics);
        if (!Number.isFinite(measured)) {
          return { fits: false, reason: '글꼴의 실제 크기를 측정할 수 없습니다.' };
        }
        if (measured <= width) {
          current = candidate;
        } else if (current) {
          lines.push(current);
          current = character;
          if (inkWidth(measure(current, fontSize)) > width) { failed = true; break; }
        } else {
          failed = true;
          break;
        }
      }
      if (lines.length >= maxLines) { failed = true; break; }
    }
    if (failed) continue;
    lines.push(current);
    const lineMetrics = lines.map((line) => measure(line, fontSize));
    let ascent = fontSize * 0.8;
    let descent = fontSize * 0.2;
    for (const metrics of lineMetrics) {
      const measuredAscent = metrics.actualBoundingBoxAscent ?? fontSize * 0.8;
      const measuredDescent = metrics.actualBoundingBoxDescent ?? fontSize * 0.2;
      if (![metrics.width, measuredAscent, measuredDescent].every(Number.isFinite)) {
        return { fits: false, reason: '글꼴의 실제 크기를 측정할 수 없습니다.' };
      }
      ascent = Math.max(ascent, measuredAscent);
      descent = Math.max(descent, measuredDescent);
    }
    lineHeight = Math.max(lineHeight, ascent + descent);
    if (ascent + descent + (lines.length - 1) * lineHeight > height) continue;
    const fitted: LayoutFittedLine[] = [];
    for (let index = 0; index < lines.length; index++) {
      const metrics = lineMetrics[index];
      const left = Math.max(0, metrics.actualBoundingBoxLeft ?? 0);
      const x = box[0] + padding + left;
      const baseline = box[1] + padding + ascent + index * lineHeight;
      // Bounds are checked in local coordinates to avoid subtractive rounding at page offsets.
      if (![metrics.width, left].every(Number.isFinite) || inkWidth(metrics) > width) {
        failed = true;
        break;
      }
      fitted.push({ text: lines[index], x, baseline, width: inkWidth(metrics) });
    }
    if (!failed) return { fits: true, fontSize, lineHeight, lines: fitted };
  }
  return { fits: false, reason: `최소 가독 크기(${minimum}pt)에서도 전체 번역이 영역에 들어가지 않아 원문을 보존합니다.` };
}
