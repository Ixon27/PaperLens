import type { LayoutTranslationRegion } from '../../shared/layout-translation';

export type Box = [number, number, number, number];
export type Matrix = [number, number, number, number, number, number];
export const multiply = (a: readonly number[], b: readonly number[]): Matrix => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
export function transformedBox(m: readonly number[], x0: number, y0: number, x1: number, y1: number): Box {
  const points = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
}
export function intersection(a: Box, b: Box): number {
  return Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
}
export const overlaps = (a: Box, b: Box) => intersection(a, b) > 0.05;
export function protectedTokens(source: string): string[] {
  const tokens: string[] = source.match(/(?:[+−-]?\d+(?:[.,]\d+)*(?:[eE][+−-]?\d+)?|[%=+−×÷^_{}<>\u0370-\u03ff\u2100-\u214f\u2190-\u22ff])/gu) ?? [];
  for (const match of source.matchAll(/\d\s*((?:[mkMµμncp]?)(?:Hz|Pa|mol|g|m|L|K|s|V|W|J|N|A|Bq|Gy|Sv))\b/gu)) tokens.push(`unit:${match[1]}`);
  for (const match of source.matchAll(/\b(?:[A-Za-z][A-Za-z0-9_.:-]*\d[A-Za-z0-9_.:-]*|[a-z]+[A-Z]{2,}(?:-[A-Za-z]+)*)\b/gu)) tokens.push(`identifier:${match[0]}`);
  return tokens;
}
export function tokensPreserved(source: string, ko: string): boolean {
  const count = (values: string[]) => values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map<string, number>());
  const a = count(protectedTokens(source)), b = count(protectedTokens(ko));
  return a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);
}
export function protectedSource(source: string): boolean {
  const value = source.trim();
  if (/^(?:https?:\/\/|doi:|10\.\d{4,9}\/)\S+$/iu.test(value)) return true;
  if (/^[A-Za-z][A-Za-z0-9_.:-]*\d[A-Za-z0-9_.:-]*$/u.test(value)) return true;
  const units = value.replace(/[\d\s.,()%+−–—\-*/^⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+/gu, ' ').trim().split(/\s+/u);
  if (units.length && units.every((unit) => /^(?:[fpnumkMµμ]?(?:g|l|L|m|s|mol|M|Hz|Pa|V|W|J|N)|kg|IU|U|pH)$/u.test(unit))) return true;
  if (!/[A-Za-z]{2,}/.test(source)) return true;
  const words = source.match(/[A-Za-z]{2,}/g) ?? [];
  return words.length <= 1 && /[=+×÷∑∫√^_{}\u0370-\u03ff\u2190-\u22ff]/u.test(source);
}
export function nativeRegion(item: { str: string; transform: number[]; width: number; height: number; dir: string }, style: { ascent?: number; descent?: number; vertical?: boolean } | undefined, viewport: { transform: number[]; scale: number }, id: string): LayoutTranslationRegion {
  const m = multiply(viewport.transform, item.transform);
  const fontSize = Math.hypot(m[2], m[3]);
  const baselineLength = Math.hypot(m[0], m[1]);
  const width = Math.abs(item.width * viewport.scale);
  const u = baselineLength ? [m[0] / baselineLength, m[1] / baselineLength] : [1, 0];
  const ascent = Number.isFinite(style?.ascent) ? style!.ascent! : 0.8;
  const descent = Number.isFinite(style?.descent) ? style!.descent! : -0.2;
  const corners = [0, width].flatMap((w) => [descent, ascent].map((h) => [m[4] + u[0] * w + m[2] * h, m[5] + u[1] * w + m[3] * h]));
  const xs = corners.map(([x]) => x), ys = corners.map(([, y]) => y);
  // Explicit erasure margin, checked against raster, neighbors and drawing bounds later.
  const margin = 1;
  const box: Box = [Math.min(...xs) - margin, Math.min(...ys) - margin, Math.max(...xs) - Math.min(...xs) + margin * 2, Math.max(...ys) - Math.min(...ys) + margin * 2];
  const rotation = Math.atan2(m[1], m[0]) * 180 / Math.PI;
  const kind = protectedSource(item.str) ? 'protected' : 'text';
  const metricKnown = Number.isFinite(style?.ascent) && Number.isFinite(style?.descent);
  const orthogonal = Math.abs(m[0] * m[2] + m[1] * m[3]) < 0.001 * Math.max(1, baselineLength * fontSize);
  const safe = metricKnown && orthogonal && !style?.vertical && item.dir !== 'ttb' && Math.abs(rotation) < 0.01 && kind === 'text' && !/[=^_\u0370-\u03ff\u2190-\u22ff]/u.test(item.str);
  return { id, source: item.str, ko: null, box, fontSize, rotation, origin: 'pdf', kind, confidence: 1, safe, ...(!safe ? { reason: kind === 'protected' ? '수식·숫자·기호 원문 보존' : '회전·수식·글꼴 기하를 안전하게 지울 수 없어 원문 보존' } : {}) };
}
/** Reject OCR at native locations, even if recognition differs (ligatures, OCR errors). */
export function duplicatesNative(box: Box, native: Pick<LayoutTranslationRegion, 'box'>[]): boolean {
  const area = box[2] * box[3];
  return area <= 0 || native.some((region) => intersection(box, region.box) / area > 0.2);
}

/** White perimeter + no long internal rule. This is necessary, never sufficient for OCR. */
export function plainRaster(data: Uint8ClampedArray, width: number, height: number, box: Box, scale: number, fontSize: number): boolean {
  const x0 = Math.floor(box[0] * scale), y0 = Math.floor(box[1] * scale), x1 = Math.ceil((box[0] + box[2]) * scale), y1 = Math.ceil((box[1] + box[3]) * scale);
  if (x0 < 1 || y0 < 1 || x1 >= width - 1 || y1 >= height - 1 || x1 <= x0 || y1 <= y0) return false;
  const white = (x: number, y: number) => { const i = (y * width + x) * 4; return data[i] >= 245 && data[i + 1] >= 245 && data[i + 2] >= 245 && data[i + 3] >= 250; };
  for (let x = x0; x <= x1; x++) if (!white(x, y0) || !white(x, y1)) return false;
  for (let y = y0; y <= y1; y++) if (!white(x0, y) || !white(x1, y)) return false;
  const limit = Math.max(12, fontSize * scale * 1.5);
  for (let y = y0 + 1; y < y1; y++) {
    let run = 0;
    for (let x = x0 + 1; x < x1; x++) { run = white(x, y) ? 0 : run + 1; if (run > limit) return false; }
  }
  for (let x = x0 + 1; x < x1; x++) {
    let run = 0;
    for (let y = y0 + 1; y < y1; y++) { run = white(x, y) ? 0 : run + 1; if (run > Math.max(limit, fontSize * scale * 1.8)) return false; }
  }
  return true;
}

/** Font ascent/descent boxes can overlap despite a real white gutter between text rows.
 * Partition only those overlaps, and accept a tighter box only with a white raster fence.
 * A boundary through a glyph, equation or rule fails the fence and retains original bounds.
 */
export function refineNativeBoxes(regions: LayoutTranslationRegion[], raster: { data: Uint8ClampedArray; width: number; height: number; scale: number }): void {
  const bounds = regions.map(({ box }) => [box[0], box[1], box[0] + box[2], box[1] + box[3]]);
  let comparisons = 0;
  pairs: for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
    if (++comparisons > 2_000_000) break pairs;
    const a = regions[i], b = regions[j];
    if (Math.abs(a.rotation) > 0.01 || Math.abs(b.rotation) > 0.01 || !overlaps(a.box, b.box)) continue;
    const centerA = a.box[1] + a.box[3] / 2, centerB = b.box[1] + b.box[3] / 2;
    if (Math.abs(centerA - centerB) > Math.min(a.fontSize, b.fontSize) * 0.35) {
      const upper = centerA < centerB ? i : j, lower = centerA < centerB ? j : i;
      const boundary = (regions[upper].box[1] + regions[upper].box[3] + regions[lower].box[1]) / 2;
      bounds[upper][3] = Math.min(bounds[upper][3], boundary);
      bounds[lower][1] = Math.max(bounds[lower][1], boundary);
    } else {
      const left = a.box[0] < b.box[0] ? i : j, right = a.box[0] < b.box[0] ? j : i;
      const boundary = (regions[left].box[0] + regions[left].box[2] + regions[right].box[0]) / 2;
      bounds[left][2] = Math.min(bounds[left][2], boundary);
      bounds[right][0] = Math.max(bounds[right][0], boundary);
    }
  }
  for (let i = 0; i < regions.length; i++) {
    const [left, top, right, bottom] = bounds[i];
    const box: Box = [left, top, right - left, bottom - top];
    if (box[2] > 0.5 && box[3] > 0.5 && box.some((value, index) => value !== regions[i].box[index]) && plainRaster(raster.data, raster.width, raster.height, box, raster.scale, regions[i].fontSize)) regions[i].box = box;
  }
  // A protected neighbor may retain its original broad metric box (e.g. an
  // italic panel marker). Shrink only the opposite box if its fence stays white.
  comparisons = 0;
  remaining: for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
    if (++comparisons > 2_000_000) break remaining;
    const a = regions[i], b = regions[j];
    if (Math.abs(a.rotation) > 0.01 || Math.abs(b.rotation) > 0.01 || !overlaps(a.box, b.box)) continue;
    const vertical = Math.abs(a.box[1] + a.box[3] / 2 - b.box[1] - b.box[3] / 2) > Math.min(a.fontSize, b.fontSize) * 0.35;
    const first = vertical ? (a.box[1] < b.box[1] ? a : b) : (a.box[0] < b.box[0] ? a : b);
    const second = first === a ? b : a;
    const trimmedFirst: Box = vertical ? [first.box[0], first.box[1], first.box[2], second.box[1] - first.box[1]] : [first.box[0], first.box[1], second.box[0] - first.box[0], first.box[3]];
    if (trimmedFirst[2] > 0.5 && trimmedFirst[3] > 0.5 && plainRaster(raster.data, raster.width, raster.height, trimmedFirst, raster.scale, first.fontSize)) { first.box = trimmedFirst; continue; }
    const trimmedSecond: Box = vertical ? [second.box[0], first.box[1] + first.box[3], second.box[2], second.box[1] + second.box[3] - first.box[1] - first.box[3]] : [first.box[0] + first.box[2], second.box[1], second.box[0] + second.box[2] - first.box[0] - first.box[2], second.box[3]];
    if (trimmedSecond[2] > 0.5 && trimmedSecond[3] > 0.5 && plainRaster(raster.data, raster.width, raster.height, trimmedSecond, raster.scale, second.fontSize)) second.box = trimmedSecond;
  }
}

/** OCR erasure needs isolated, high-confidence glyph coverage, not just a white rectangle. */
export function ocrGlyphRaster(data: Uint8ClampedArray, width: number, height: number, box: Box, scale: number, fontSize: number, symbols: Array<{ text: string; confidence: number; box: Box }>): boolean {
  if (symbols.length < 2 || symbols.length > 128 || symbols.some((symbol) => symbol.confidence < 80 || !/^[A-Za-z0-9.,:;!?'"()/%+-]$/.test(symbol.text))) return false;
  if (!plainRaster(data, width, height, box, scale, fontSize)) return false;
  const glyphs = symbols.map((symbol) => [Math.floor(symbol.box[0] * scale) - 1, Math.floor(symbol.box[1] * scale) - 1, Math.ceil((symbol.box[0] + symbol.box[2]) * scale) + 1, Math.ceil((symbol.box[1] + symbol.box[3]) * scale) + 1]);
  if (symbols.some((symbol) => !symbol.box.every(Number.isFinite) || symbol.box[2] <= 0 || symbol.box[3] <= 0 || symbol.box[2] > fontSize * 1.6 || symbol.box[3] > fontSize * 1.6)) return false;
  const x0 = Math.floor(box[0] * scale), y0 = Math.floor(box[1] * scale), x1 = Math.ceil((box[0] + box[2]) * scale), y1 = Math.ceil((box[1] + box[3]) * scale);
  let ink = 0;
  for (let y = y0 + 1; y < y1; y++) for (let x = x0 + 1; x < x1; x++) {
    const i = (y * width + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r >= 245 && g >= 245 && b >= 245) continue;
    if (Math.max(r, g, b) - Math.min(r, g, b) > 12) return false;
    if (!glyphs.some(([left, top, right, bottom]) => x >= left && x <= right && y >= top && y <= bottom)) {
      // Tesseract boxes describe thresholded ink. Resampling adds a pale, at-most
      // two-pixel fringe beyond that binary box; it is not unexplained drawing ink.
      const fringe = Math.min(r, g, b) >= 128 && glyphs.some(([left, top, right, bottom]) => x >= left - 1 && x <= right + 1 && y >= top - 1 && y <= bottom + 1);
      if (!fringe) return false;
    }
    ink++;
  }
  const density = ink / ((x1 - x0) * (y1 - y0));
  return density > 0.015 && density < 0.45;
}

/** Narrow inline gaps only; never bridge another cell, column, or vector divider. */
export function inlineUnionBox(left: Box, right: Box, fontSize: number, dividers: Box[], margin = 1): Box | null {
  const gap = right[0] - (left[0] + left[2]) + 2 * margin;
  if (gap < -0.15 * fontSize || gap > 0.65 * fontSize) return null;
  const x = Math.min(left[0], right[0]), y = Math.min(left[1], right[1]);
  const box: Box = [x, y, Math.max(left[0] + left[2], right[0] + right[2]) - x, Math.max(left[1] + left[3], right[1] + right[3]) - y];
  if (dividers.some((divider) => overlaps(box, divider))) return null;
  return box;
}

/** Raster table rules can exist inside images, absent from the PDF vector operators. */
export function inlineRasterDivider(data: Uint8ClampedArray, width: number, height: number, left: Box, right: Box, scale: number, fontSize: number): boolean {
  const x0 = Math.ceil((left[0] + left[2] - 0.5) * scale), x1 = Math.floor((right[0] + 0.5) * scale);
  const y0 = Math.max(0, Math.floor(Math.min(left[1], right[1]) * scale)), y1 = Math.min(height - 1, Math.ceil(Math.max(left[1] + left[3], right[1] + right[3]) * scale));
  for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) {
    let run = 0;
    for (let y = y0; y <= y1; y++) {
      const i = (y * width + x) * 4;
      run = Math.min(data[i], data[i + 1], data[i + 2]) < 230 ? run + 1 : 0;
      // A divider crosses the glyph-height band; a glyph-edge antialias fringe
      // can be tall, but cannot extend beyond the word's measured ink height.
      if (run >= fontSize * scale * 1.1) return true;
    }
  }
  return false;
}
