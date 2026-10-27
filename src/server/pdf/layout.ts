import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';

type Box = [number, number, number, number];

/**
 * [xMin, yMin, xMax, yMax] in PDF points, top-left origin. A fifth entry is the page number,
 * present only on lines of a paragraph that continues onto a later page than the block's own.
 */
export type LineBox = Box | [number, number, number, number, number];

/**
 * `body`, `heading` and `caption` are the paper's reading flow. `aside` is everything else that
 * still carries text: running headers/footers, page numbers, front matter, margin notes, table
 * cells, equations and footnotes.
 */
export type BlockKind = 'body' | 'heading' | 'caption' | 'aside';

/**
 * Characters `[start, end)` of a block's text drawn by one PDF.js text item: `item` counts the
 * page's items with non-empty `str` in content order, which is the order of the viewer's
 * text-layer spans.
 */
export type TextSpan = [page: number, item: number, start: number, end: number];

export interface Block {
  idx: number;
  page: number;
  text: string;
  lines: LineBox[];
  pageW: number;
  pageH: number;
  kind: BlockKind;
  isRef: boolean;
  spans: TextSpan[];
}

/** Bump when block boundaries, kinds or spans change, so untranslated papers are split again. */
export const LAYOUT_VERSION = 3;

export interface TextViewport {
  width: number;
  height: number;
  transform: number[];
}

export interface PageText {
  viewport: TextViewport;
  content: TextContent;
}

interface Run {
  text: string;
  box: Box;
  baseline: number;
  size: number;
  font: string;
  /** Set at an angle (page-edge stamps); never part of a horizontal text line. */
  rotated: boolean;
  /** Text-layer index of the item (see TextSpan). */
  item: number;
}

interface Line extends Omit<Run, 'item'> {
  /** Number of separate text segments sharing this line's baseline (≥3: a table row). */
  cells: number;
  /** Where each run's characters sit in `text`. */
  parts: { item: number; start: number; end: number }[];
}

/** Text with the source characters behind it. */
interface Mapped {
  text: string;
  spans: TextSpan[];
}

interface Paragraph {
  lines: Line[];
  heading: boolean;
}

interface Piece {
  page: number;
  region: number;
  lines: { line: Line; page: number }[];
  text: string;
  spans: TextSpan[];
  kind: BlockKind;
  furniture: boolean;
  /** Set in smaller type than the body text, inside the body column. */
  small: boolean;
  pageW: number;
  pageH: number;
}

const REF_HEADING = /^\s*(\d+\.?\s*)?(references( and notes)?|literature cited|bibliography|참고문헌)\s*$/i;
const REF_END = /^\s*(supplementary|appendix|acknowledg|figure legends)/i;
const SECTION_HEADING = /^(?:(?:\d+(?:\.\d+)*|[IVX]+|[A-Z])\.?\s+)?(?:abstract|introduction|background|materials and methods|methods|methodology|experimental(?: procedures| section)?|results(?: and discussion)?|discussion|conclusions?|acknowledg(?:e)?ments?|funding|conflicts? of interest|author contributions|data availability(?: statement)?)\s*$/i;
const NUMBERED_HEADING = /^(?:\d+(?:\.\d+)*\.?|[IVX]+\.|[A-Z]\.)\s+\p{Lu}/u;
const LIST_START = /^(?:\[\d{1,3}\]|\d{1,3}[.)]|[•●▪])\s/;
// "Fig. 2." / "Table 1:" / Springer's "Fig. 4 Title" (number followed directly by a capitalized title).
const CAPTION = /^(?:fig(?:ure)?|table|scheme|chart|supplementary (?:figure|table))\.?\s*S?(?:\d+|[IVX]+)[A-Za-z]?(?:\s*[.:|—–-]|\s+(?=\p{Lu}))/iu;
const KEYWORDS = /^(?:key\s?words?|index terms|abbreviations)\s*[:：.—–-]/i;
const ABSTRACT_HEADING = /^(?:\d+\.?\s*)?abstract\.?$/i;
const ABSTRACT_INLINE = /^abstract\s*[:.—–-]?\s+\S/i;
/** Administrative back matter: not part of the paper's argument, so not reading text. */
const BACK_MATTER = /^(?:\d+\.?\s*)?(?:supplementary materials?|author contributions?|funding|institutional review board statement|informed consent statement|ethics statement|data availability(?: statement)?|conflicts? of interest|competing interests?|declaration of competing interest|acknowledg(?:e)?ments?|abbreviations)\b/i;
const PAGE_NUMBER = /^(?:page\s*)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?$/i;
/** Running headers/footers live in these top/bottom fractions of the page. */
const MARGIN_BAND = 0.075;

const shiftSpans = (spans: TextSpan[], by: number): TextSpan[] => spans.map(([page, item, start, end]) => [page, item, start + by, end + by]);

/**
 * Join two pieces of text the way a reader reads a line break, keeping the spans aligned:
 * repair line-break hyphenation without changing compound names or identifiers.
 */
function joinMapped(a: Mapped, b: Mapped): Mapped {
  if (!a.text) return b;
  if (/[A-Za-z]-$/.test(a.text) && /^[a-z]/.test(b.text)) {
    const len = a.text.length - 1;
    const kept = a.spans
      .map(([page, item, start, end]): TextSpan => [page, item, start, Math.min(end, len)])
      .filter(([, , start, end]) => start < end);
    return { text: a.text.slice(0, -1) + b.text, spans: [...kept, ...shiftSpans(b.spans, len)] };
  }
  if (a.text.endsWith('-')) return { text: a.text + b.text, spans: [...a.spans, ...shiftSpans(b.spans, a.text.length)] };
  return { text: `${a.text} ${b.text}`, spans: [...a.spans, ...shiftSpans(b.spans, a.text.length + 1)] };
}

function lineMapped(line: Line, page: number): Mapped {
  return { text: line.text, spans: line.parts.map(({ item, start, end }): TextSpan => [page, item, start, end]) };
}

export function markReferences(blocks: Block[]): void {
  // Also makes this safe to apply again after combining pages.
  for (const block of blocks) block.isRef = false;
  let start = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (REF_HEADING.test(blocks[i].text)) {
      start = i;
      break;
    }
  }
  if (start === -1) return;
  for (let i = start + 1; i < blocks.length; i++) {
    if (REF_END.test(blocks[i].text)) break;
    blocks[i].isRef = true;
  }
}

function median(values: number[]): number {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

function union(a: Box, b: Box): Box {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function textRun(item: TextItem, content: TextContent, viewport: TextViewport, domIndex: number): Run | null {
  const text = item.str.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ');
  if (!text.trim()) return null;
  const [a, b, c, d, e, f] = viewport.transform;
  const [ta, tb, tc, td, te, tf] = item.transform as number[];
  const x = a * te + c * tf + e;
  const y = b * te + d * tf + f;
  const size = Math.hypot(a * tc + c * td, b * tc + d * td);
  if (!(size > 0) || !Number.isFinite(x + y + size + item.width)) return null;
  const style = content.styles[item.fontName];
  let angle = Math.atan2(b * ta + d * tb, a * ta + c * tb);
  if (style?.vertical) angle += Math.PI / 2;
  const ascent = Number.isFinite(style?.ascent) ? style.ascent : Number.isFinite(style?.descent) ? 1 + style.descent : 0.8;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const topX = x + uy * size * ascent;
  const topY = y - ux * size * ascent;
  const width = Math.abs(item.width) * Math.hypot(a, b);
  // The same font-height/ascent model used by PDF.js's text layer, including cropped pages.
  const dx = ux * width;
  const dy = uy * width;
  const hx = -uy * size;
  const hy = ux * size;
  return {
    text,
    box: [topX + Math.min(0, dx) + Math.min(0, hx), topY + Math.min(0, dy) + Math.min(0, hy),
      topX + Math.max(0, dx) + Math.max(0, hx), topY + Math.max(0, dy) + Math.max(0, hy)],
    baseline: y,
    size,
    font: item.fontName,
    rotated: Math.abs(uy) > 0.2,
    item: domIndex,
  };
}

function makeLine(runs: Run[], cells: number): Line {
  const first = runs[0];
  let text = first.text;
  let box = first.box;
  let main = first;
  let previous = first;
  const parts = [{ item: first.item, start: 0, end: first.text.length }];
  for (let i = 1; i < runs.length; i++) {
    const run = runs[i];
    const gap = run.box[0] - previous.box[2];
    if (gap > Math.min(previous.size, run.size) * 0.12 && !/\s$/.test(text) && !/^\s/.test(run.text)) text += ' ';
    parts.push({ item: run.item, start: text.length, end: text.length + run.text.length });
    text += run.text;
    box = union(box, run.box);
    if (run.text.length > main.text.length) main = run;
    previous = run;
  }
  const trimmed = text.trim();
  const lead = text.length - text.trimStart().length;
  const kept = parts
    .map((p) => ({ item: p.item, start: Math.max(0, p.start - lead), end: Math.min(trimmed.length, p.end - lead) }))
    .filter((p) => p.start < p.end);
  return { text: trimmed, box, baseline: main.baseline, size: main.size, font: main.font, rotated: runs.some((run) => run.rotated), cells, parts: kept };
}

function pageLines(content: TextContent, viewport: TextViewport): Line[] {
  const runs: Run[] = [];
  const lines: Line[] = [];
  // The viewer's text layer draws one span per item with a non-empty `str`, in content order.
  let dom = 0;
  for (const item of content.items) {
    if (!('str' in item)) continue;
    const domIndex = item.str !== '' ? dom++ : -1;
    const run = textRun(item, content, viewport, domIndex);
    if (!run) continue;
    if (run.rotated) lines.push(makeLine([run], 1));
    else runs.push(run);
  }
  runs.sort((a, b) => a.baseline - b.baseline || a.box[0] - b.box[0]);
  const rows: { baseline: number; size: number; runs: Run[] }[] = [];
  for (const run of runs) {
    let row: typeof rows[number] | undefined;
    let distance = Infinity;
    // Only nearby baselines can belong to this row (superscripts included).
    for (let i = rows.length - 1; i >= 0; i--) {
      const candidate = rows[i];
      const delta = Math.abs(candidate.baseline - run.baseline);
      if (run.baseline - candidate.baseline > Math.max(candidate.size, run.size)) break;
      if (delta <= Math.max(candidate.size, run.size) * 0.4 && delta < distance) {
        row = candidate;
        distance = delta;
      }
    }
    if (row) {
      row.runs.push(run);
      if (run.size > row.size) {
        row.baseline = run.baseline;
        row.size = run.size;
      }
    } else rows.push({ baseline: run.baseline, size: run.size, runs: [run] });
  }
  // Narrow gutters can be smaller than the blank threshold below; split rows at the gutter itself.
  const gutter = columnSplit(runs, viewport.width);
  for (const row of rows) {
    row.runs.sort((a, b) => a.box[0] - b.box[0]);
    const segments: Run[][] = [];
    let segment: Run[] = [];
    for (const run of row.runs) {
      const previous = segment.at(-1);
      if (previous) {
        const gap = run.box[0] - previous.box[2];
        const smaller = Math.min(run.size, previous.size);
        // A large blank is a column/table boundary, not an ordinary word space; a different type
        // size across a visible gap is a margin note set beside the body text.
        if (gap > Math.max(row.size * 2, viewport.width * 0.025) ||
          (gutter !== null && previous.box[2] <= gutter && run.box[0] >= gutter && gap > smaller * 0.5) ||
          (gap > smaller * 0.8 && Math.abs(run.size - previous.size) > smaller * 0.12)) {
          segments.push(segment);
          segment = [];
        }
      }
      segment.push(run);
    }
    if (segment.length) segments.push(segment);
    for (const runsOfSegment of segments) lines.push(makeLine(runsOfSegment, segments.length));
  }
  return lines.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
}

/**
 * Find a persistent central gutter between column-width lines (table cells are narrower).
 * Full-width lines are separate bands and do not count against it; shorter crossing lines do.
 */
function columnSplit(lines: { box: Box }[], pageWidth: number): number | null {
  const body = lines.filter((line) => line.box[2] - line.box[0] >= pageWidth * 0.12);
  let best: number | null = null;
  let bestScore = 0;
  for (let step = 30; step <= 70; step++) {
    const x = pageWidth * step / 100;
    let left = 0;
    let right = 0;
    let narrowCrossing = 0;
    for (const line of body) {
      const width = line.box[2] - line.box[0];
      if (line.box[2] <= x) left += width >= pageWidth * 0.25 ? 1 : 0;
      else if (line.box[0] >= x) right += width >= pageWidth * 0.25 ? 1 : 0;
      else if (width < pageWidth * 0.6) narrowCrossing++;
    }
    if (left < 3 || right < 3) continue;
    const score = 2 * Math.min(left, right) - narrowCrossing;
    if (score > bestScore || (score === bestScore && best !== null && Math.abs(x - pageWidth / 2) < Math.abs(best - pageWidth / 2))) {
      bestScore = score;
      best = x;
    }
  }
  return best;
}

/** Full-width material separates column bands; each band reads down left, then down right. */
function readingRegions(lines: Line[], pageWidth: number): Line[][] {
  const split = columnSplit(lines, pageWidth);
  if (split === null) return [lines];
  const regions: Line[][] = [];
  let left: Line[] = [];
  let right: Line[] = [];
  let spanning: Line[] = [];
  const flushColumns = () => {
    if (left.length) regions.push(left);
    if (right.length) regions.push(right);
    left = [];
    right = [];
  };
  for (const line of lines) {
    if (line.box[0] < split && line.box[2] > split) {
      flushColumns();
      spanning.push(line);
    } else {
      if (spanning.length) {
        regions.push(spanning);
        spanning = [];
      }
      (line.box[0] >= split ? right : left).push(line);
    }
  }
  flushColumns();
  if (spanning.length) regions.push(spanning);
  return regions;
}

function isHeading(line: Line, before: Line | undefined, after: Line | undefined, width: number): boolean {
  // "Supplementary Materials: The following…" is a run-in label inside a paragraph, not a heading.
  const endHeading = REF_END.test(line.text) && !/[:.]\s*\S/.test(line.text) && line.text.length <= 60;
  if (REF_HEADING.test(line.text) || endHeading || SECTION_HEADING.test(line.text)) return true;
  if (line.text.length > 120 || /[.!?;,]$/.test(line.text)) return false;
  const neighbor = after ?? before;
  if (!neighbor) return false;
  const headingText = line.text.replace(/^\d+(?:\.\d+)*\.?\s+/, '');
  // A different font inside prose (especially italic reference journals) is not a heading.
  const separatedBefore = !before || line.baseline - before.baseline > line.size * 1.35;
  const separatedAfter = !after || after.baseline - line.baseline > line.size * 1.35;
  return line.font !== neighbor.font && line.size >= neighbor.size * 0.98 &&
    line.box[2] - line.box[0] < width * 0.8 && separatedBefore && separatedAfter &&
    /^[A-Z가-힣]/.test(headingText) && !/[.,;:[\](){}=]|\d{4}/.test(headingText);
}

/**
 * Group lines (top to bottom) into paragraphs. Text set side by side that no column split
 * separated (a margin note next to a column, a boxed summary) forms separate streams: a line
 * continues only a paragraph whose last line it overlaps horizontally.
 */
function paragraphs(lines: Line[]): Paragraph[] {
  if (!lines.length) return [];
  const overlaps = (a: Line, b: Line) => a.box[0] < b.box[2] && b.box[0] < a.box[2];
  const width = Math.max(...lines.map((line) => line.box[2])) - Math.min(...lines.map((line) => line.box[0]));
  // A text block's margins, from the lines stacked with this one; a stray overlong line (URL,
  // formula) must not move the right margin.
  const margins = (line: Line) => {
    const stack = lines.filter((other) => other.text.length >= 20 && overlaps(other, line));
    const rights = stack.map((other) => other.box[2]).sort((a, b) => a - b);
    const right = rights.length ? rights[Math.floor((rights.length - 1) * 0.9)] : line.box[2];
    return { right, width: right - Math.min(line.box[0], ...stack.map((other) => other.box[0])) };
  };
  const spacings: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const above = lines.slice(0, i).findLast((other) => overlaps(other, lines[i]));
    if (!above) continue;
    const gap = lines[i].baseline - above.baseline;
    const size = Math.max(lines[i].size, above.size);
    if (gap > size * 0.7 && gap < size * 2) spacings.push(gap);
  }
  const leading = median(spacings);
  const result: Paragraph[] = [];
  const open: { lines: Line[]; left: number }[] = [];
  const close = (stream: (typeof open)[number]) => {
    open.splice(open.indexOf(stream), 1);
    result.push({ lines: stream.lines, heading: false });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stream = open.findLast((candidate) => overlaps(candidate.lines.at(-1)!, line));
    const previous = stream?.lines.at(-1);
    const heading = isHeading(line, previous, lines.slice(i + 1).find((other) => overlaps(other, line)), width);
    let newParagraph = heading || LIST_START.test(line.text);
    if (stream && previous) {
      const size = Math.max(line.size, previous.size);
      const gap = line.baseline - previous.baseline;
      const indented = line.box[0] - stream.left > size * 0.7 && !LIST_START.test(stream.lines[0].text);
      // Justified lines reach the margin; only a line that stops well short of it ends a paragraph.
      const margin = margins(previous);
      const shortEnding = !LIST_START.test(stream.lines[0].text) &&
        /[.!?:]$/.test(previous.text) && previous.box[2] < margin.right - Math.max(margin.width * 0.15, size * 2);
      newParagraph ||= gap > (leading || size * 1.2) * 1.35 || gap <= 0 ||
        Math.abs(line.size - previous.size) > size * 0.18 || indented || shortEnding;
      if (!newParagraph) {
        stream.lines.push(line);
        stream.left = Math.min(stream.left, line.box[0]);
        continue;
      }
      close(stream);
    }
    if (heading) result.push({ lines: [line], heading: true });
    else open.push({ lines: [line], left: line.box[0] });
  }
  for (const stream of [...open]) close(stream);
  return result.sort((a, b) => a.lines[0].box[1] - b.lines[0].box[1] || a.lines[0].box[0] - b.lines[0].box[0]);
}

/**
 * The body text size: the type size carrying the most characters of running text. Narrow lines
 * (table cells, labels) and the pages after the reference list heading (references, appendices,
 * which are often set smaller and can outweigh the article in long bibliographies) are not counted.
 */
function dominantSize(pages: { lines: Line[]; width: number }[]): number {
  let last = pages.length - 1;
  for (let i = pages.length - 1; i >= 0; i--) {
    if (pages[i].lines.some((line) => REF_HEADING.test(line.text))) {
      last = i;
      break;
    }
  }
  const weight = new Map<number, number>();
  for (const { lines, width } of pages.slice(0, last + 1)) {
    for (const line of lines) {
      if (line.box[2] - line.box[0] < width * 0.25) continue;
      const key = Math.round(line.size * 4) / 4;
      weight.set(key, (weight.get(key) ?? 0) + line.text.length);
    }
  }
  let best = 0;
  let bestWeight = 0;
  for (const [size, w] of weight) {
    if (w > bestWeight) {
      best = size;
      bestWeight = w;
    }
  }
  return best;
}

/** Running headers/footers: page numbers, or margin text repeated (digits aside) on several pages. */
function findFurniture(pages: { lines: Line[]; height: number }[]): Set<Line> {
  const inMargin = (line: Line, height: number) => line.box[3] <= height * MARGIN_BAND || line.box[1] >= height * (1 - MARGIN_BAND);
  const key = (line: Line) => line.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
  const pagesByKey = new Map<string, Set<number>>();
  pages.forEach(({ lines, height }, page) => {
    for (const line of lines) {
      if (!inMargin(line, height)) continue;
      const seen = pagesByKey.get(key(line)) ?? new Set<number>();
      seen.add(page);
      pagesByKey.set(key(line), seen);
    }
  });
  const furniture = new Set<Line>();
  for (const { lines, height } of pages) {
    for (const line of lines) {
      if (inMargin(line, height) && (PAGE_NUMBER.test(line.text) || pagesByKey.get(key(line))!.size >= 2)) furniture.add(line);
    }
  }
  return furniture;
}

function clusterLefts(lefts: number[], minCount: number): number[] {
  const clusters: { left: number; last: number; count: number }[] = [];
  for (const x of [...lefts].sort((a, b) => a - b)) {
    const cluster = clusters.at(-1);
    if (cluster && x - cluster.last <= 4) {
      cluster.last = x;
      cluster.count++;
    } else clusters.push({ left: x, last: x, count: 1 });
  }
  return clusters.filter((cluster) => cluster.count >= minCount).map((cluster) => cluster.left);
}

/**
 * Left edges of the text columns on each page, from full-length lines (margin notes and table cells
 * are narrower): body-size edges common across the document, plus the page's own edges at any
 * size (a first page often sets its abstract on its own measure, sometimes in smaller type).
 */
function columnLefts(pages: { lines: Line[]; width: number }[], isBodySize: (line: Line) => boolean, furniture: Set<Line>): number[][] {
  const full = pages.map(({ lines, width }) =>
    lines.filter((line) => !furniture.has(line) && line.cells <= 2 && line.box[2] - line.box[0] >= width * 0.25));
  const body = full.flatMap((lines) => lines.filter(isBodySize).map((line) => line.box[0]));
  const shared = clusterLefts(body, Math.max(3, body.length * 0.05));
  return full.map((lines) => {
    const lefts = lines.map((line) => line.box[0]);
    return [...new Set([...shared, ...clusterLefts(lefts, Math.max(3, lefts.length * 0.1))])].sort((a, b) => a - b);
  });
}

/** A body paragraph cut by a column/page break or an inserted figure/table continues in `next`. */
function continues(previous: Piece, next: Piece, columns: number[]): boolean {
  if (/[.!?:]["'”’)\]]*$/.test(previous.text)) return false;
  const end = previous.lines.at(-1)!;
  const start = next.lines[0];
  if (start.page - end.page > 2 || next.pageW !== previous.pageW || next.pageH !== previous.pageH) return false;
  const first = start.line;
  const rest = next.lines.slice(1).map(({ line }) => line.box[0]);
  const margin = rest.length ? Math.min(...rest) : columns.filter((x) => x <= first.box[0] + 3).at(-1) ?? first.box[0];
  if (first.box[0] - margin > first.size * 0.7) return false;
  // A new sentence after the break is a new paragraph unless the previous one stopped mid-phrase.
  return /^[\p{Ll}\d([]/u.test(next.text) || /[,;\-–(/]$/.test(previous.text);
}

/**
 * Geometry-only layout of a whole document, independent of PDF parsing; accepts genuine PDF.js
 * text-content data. Pages are numbered from 1 in the given order.
 */
export function layoutDocument(pages: PageText[]): Block[] {
  const laidOut = pages.map(({ viewport, content }) => ({
    lines: pageLines(content, viewport),
    width: viewport.width,
    height: viewport.height,
  }));
  const bodySize = dominantSize(laidOut);
  const isBodySize = (line: Line) => line.size >= bodySize * 0.92 && line.size <= bodySize * 1.12;
  const furniture = findFurniture(laidOut);
  const columnsByPage = columnLefts(laidOut, isBodySize, furniture);
  const inColumn = (line: Line, columns: number[]) =>
    !columns.length || columns.some((x) => line.box[0] >= x - 3 && line.box[0] <= x + bodySize * 4);
  /** flow: body-size text and headings; small: smaller text set in the body column; aside: the rest. */
  const role = (line: Line, columns: number[], pageWidth: number): 'flow' | 'small' | 'aside' => {
    // Table rows: several short cells on one baseline (wide segments are side-by-side columns).
    if (line.cells >= 3 && line.box[2] - line.box[0] < pageWidth * 0.2) return 'aside';
    // Rotated text along the page edge (download stamps, copyright notes).
    if (line.rotated) return 'aside';
    const ratio = line.size / bodySize;
    if (ratio >= 1.5) return 'aside';
    if (ratio > 1.12) return 'flow';
    if (!inColumn(line, columns) && !SECTION_HEADING.test(line.text) && !REF_HEADING.test(line.text)) return 'aside';
    return ratio < 0.92 ? 'small' : 'flow';
  };

  // 1. Paragraphs in reading order; each role is segmented on its own so they never interleave.
  const pieces: Piece[] = [];
  laidOut.forEach(({ lines, width, height }, index) => {
    const page = index + 1;
    // The page's running-text font: a lone body-size line set in another font (bold, italic) is a heading.
    const fontChars = new Map<string, number>();
    for (const line of lines) if (isBodySize(line)) fontChars.set(line.font, (fontChars.get(line.font) ?? 0) + line.text.length);
    const bodyFont = [...fontChars].sort((a, b) => b[1] - a[1])[0]?.[0];
    const piece = (paragraph: Paragraph, region: number, lineRole: 'flow' | 'small' | 'aside' | 'furniture'): Piece => {
      const { text, spans } = paragraph.lines.reduce<Mapped>((acc, line) => joinMapped(acc, lineMapped(line, page)), { text: '', spans: [] });
      const large = paragraph.lines.some((line) => line.size > bodySize * 1.12);
      const single = paragraph.lines.length === 1 && text.length <= 150 && !/[.!?;,:]$/.test(text);
      const numbered = single && NUMBERED_HEADING.test(text);
      const lone = single && lineRole === 'flow' && /^\p{Lu}/u.test(text) && paragraph.lines[0].font !== bodyFont &&
        paragraph.lines[0].box[2] - paragraph.lines[0].box[0] < width * 0.6;
      const heading = paragraph.heading || large || numbered || lone;
      const kind: BlockKind = lineRole === 'furniture' ? 'aside'
        : CAPTION.test(text) ? 'caption'
        : lineRole === 'aside' || KEYWORDS.test(text) ? 'aside'
        : heading ? 'heading'
        : lineRole === 'small' ? 'aside'
        : 'body';
      return {
        page, region, lines: paragraph.lines.map((line) => ({ line, page })), text, spans, kind,
        furniture: lineRole === 'furniture', small: lineRole === 'small', pageW: width, pageH: height,
      };
    };
    const content = lines.filter((line) => !furniture.has(line));
    const edges = lines.filter((line) => furniture.has(line)).map((line) => piece({ lines: [line], heading: false }, -1, 'furniture'));
    const firstContent = content[0]?.box[1] ?? Infinity;
    pieces.push(...edges.filter((edge) => edge.lines[0].line.box[1] < firstContent));
    readingRegions(content, width).forEach((region, r) => {
      const items = (['flow', 'small', 'aside'] as const).flatMap((lineRole) =>
        paragraphs(region.filter((line) => role(line, columnsByPage[index], width) === lineRole)).map((paragraph) => piece(paragraph, r, lineRole)));
      items.sort((a, b) => a.lines[0].line.box[1] - b.lines[0].line.box[1]);
      pieces.push(...items.filter((item) => item.text));
    });
    pieces.push(...edges.filter((edge) => edge.lines[0].line.box[1] >= firstContent));
  });

  // Smaller type is reading text when a heading opens it (methods or abstracts set small); after
  // body text with no heading in between it is a footnote, table note or legend. Prose paragraphs
  // in a caption's type right after it are the rest of a multi-paragraph legend.
  let headed = false;
  let caption: Piece | null = null;
  for (const piece of pieces) {
    if (piece.furniture) continue;
    if (piece.kind === 'caption') {
      caption = piece;
      continue;
    }
    if (caption && piece.small && piece.kind === 'aside' && piece.page === caption.page && piece.region === caption.region &&
      piece.lines.length >= 2 && /[.!?]/.test(piece.text) && Math.abs(piece.lines[0].line.size - caption.lines[0].line.size) < 0.3) {
      piece.kind = 'caption';
      continue;
    }
    caption = null;
    if (piece.kind === 'heading') headed = true;
    else if (piece.small) {
      // Narrow margin notes stay asides even under a heading.
      const widths = piece.lines.map(({ line }) => line.box[2] - line.box[0]).sort((a, b) => a - b);
      if (headed && piece.kind === 'aside' && widths[Math.floor(widths.length / 2)] >= piece.pageW * 0.25) piece.kind = 'body';
    } else if (piece.kind === 'body') headed = false;
  }

  // 2. Front matter before the abstract is not reading text; an "Abstract:" run-in paragraph is,
  // whatever its type size (a headed small abstract was already taken in above).
  const abstractAt = pieces.findIndex((piece) => piece.page <= 2 && !piece.furniture &&
    ((piece.kind === 'heading' && ABSTRACT_HEADING.test(piece.text)) || ABSTRACT_INLINE.test(piece.text)));
  if (abstractAt >= 0) {
    for (let i = 0; i < abstractAt; i++) pieces[i].kind = 'aside';
    if (pieces[abstractAt].kind === 'aside') pieces[abstractAt].kind = 'body';
  } else {
    // Unlabeled abstracts (PNAS, Elsevier "Background & aims: …") are smaller type before the main
    // text: wide prose with sentences, unlike affiliation and correspondence notes. What precedes
    // them (title, authors) is front matter.
    const prose = (piece: Piece) => /[\p{Ll})\]]\.\s+\p{Lu}/u.test(piece.text);
    const firstText = pieces.findIndex((piece) => piece.kind === 'body' && !piece.small && piece.lines.length >= 3 && prose(piece));
    let firstAbstract = -1;
    for (let i = 0; i < (firstText < 0 ? pieces.length : firstText); i++) {
      const piece = pieces[i];
      if (piece.page > 2 || !piece.small || piece.kind !== 'aside' || piece.lines.length < 3 || piece.text.includes('@')) continue;
      const widths = piece.lines.map(({ line }) => line.box[2] - line.box[0]).sort((a, b) => a - b);
      if (widths[Math.floor(widths.length / 2)] < piece.pageW * 0.25 || !prose(piece)) continue;
      piece.kind = 'body';
      if (firstAbstract < 0) firstAbstract = i;
    }
    for (let i = 0; i < firstAbstract; i++) pieces[i].kind = 'aside';
  }

  // Back matter (funding, contributions, statements…), whether a headed section or a run-in label.
  const runIn = new RegExp(`${BACK_MATTER.source}[^:.]{0,30}[:.]`, 'i');
  let backMatter = false;
  for (const piece of pieces) {
    if (piece.kind === 'heading') backMatter = BACK_MATTER.test(piece.text);
    if (piece.kind !== 'aside' && (backMatter || runIn.test(piece.text))) piece.kind = 'aside';
  }

  // 3. Rejoin body paragraphs split by a column/page break or a figure/table placed inside them.
  const merged: Piece[] = [];
  let open: Piece | null = null;
  let interrupted = false;
  for (const piece of pieces) {
    if (piece.kind !== 'body') {
      merged.push(piece);
      if (piece.kind === 'heading') open = null;
      else interrupted = true;
      continue;
    }
    if (open) {
      const end = open.lines.at(-1)!;
      interrupted ||= piece.page !== end.page || piece.region !== open.region;
      if (interrupted && continues(open, piece, columnsByPage[piece.page - 1])) {
        open.lines.push(...piece.lines);
        const joined = joinMapped(open, piece);
        open.text = joined.text;
        open.spans = joined.spans;
        open.region = piece.region;
        interrupted = false;
        continue;
      }
    }
    merged.push(piece);
    open = piece;
    interrupted = false;
  }

  const blocks = merged.map((piece, idx): Block => ({
    idx,
    page: piece.page,
    text: piece.text,
    lines: piece.lines.map(({ line, page }): LineBox => (page === piece.page ? [...line.box] : [...line.box, page])),
    pageW: piece.pageW,
    pageH: piece.pageH,
    kind: piece.kind,
    isRef: false,
    spans: piece.spans,
  }));
  markReferences(blocks);
  return blocks;
}
