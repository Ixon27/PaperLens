import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';

export type LineBox = [number, number, number, number];

export interface Block {
  idx: number;
  page: number;
  text: string;
  /** [xMin, yMin, xMax, yMax] in PDF points, top-left origin. */
  lines: LineBox[];
  pageW: number;
  pageH: number;
  isRef: boolean;
}

export interface TextViewport {
  width: number;
  height: number;
  transform: number[];
}

interface Run {
  text: string;
  box: LineBox;
  baseline: number;
  size: number;
  font: string;
}

type Line = Run;

const REF_HEADING = /^\s*(\d+\.?\s*)?(references( and notes)?|literature cited|bibliography|참고문헌)\s*$/i;
const REF_END = /^\s*(supplementary|appendix|acknowledg|figure legends)/i;
const SECTION_HEADING = /^(?:\d+(?:\.\d+)*\.?\s+)?(?:abstract|introduction|background|materials and methods|methods|methodology|experimental(?: procedures| section)?|results(?: and discussion)?|discussion|conclusions?|acknowledg(?:e)?ments?|funding|conflicts? of interest|author contributions|data availability(?: statement)?)\s*$/i;
const LIST_START = /^(?:\[\d{1,3}\]|\d{1,3}[.)]|[•●▪])\s/;

/** Repair line-break hyphenation without changing compound names or identifiers. */
function joinLines(lines: Line[]): string {
  let text = '';
  for (const line of lines) {
    if (!text) text = line.text;
    else if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(line.text)) text = text.slice(0, -1) + line.text;
    else if (text.endsWith('-')) text += line.text;
    else text += ' ' + line.text;
  }
  return text;
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

function union(a: LineBox, b: LineBox): LineBox {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function textRun(item: TextItem, content: TextContent, viewport: TextViewport): Run | null {
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
  };
}

function makeLine(runs: Run[]): Line {
  const first = runs[0];
  let text = first.text;
  let box = first.box;
  let main = first;
  let previous = first;
  for (let i = 1; i < runs.length; i++) {
    const run = runs[i];
    const gap = run.box[0] - previous.box[2];
    if (gap > Math.min(previous.size, run.size) * 0.12 && !/\s$/.test(text) && !/^\s/.test(run.text)) text += ' ';
    text += run.text;
    box = union(box, run.box);
    if (run.text.length > main.text.length) main = run;
    previous = run;
  }
  return { text: text.trim(), box, baseline: main.baseline, size: main.size, font: main.font };
}

function pageLines(content: TextContent, viewport: TextViewport): Line[] {
  const runs: Run[] = [];
  for (const item of content.items) {
    if (!('str' in item)) continue;
    const run = textRun(item, content, viewport);
    if (run) runs.push(run);
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
  const lines: Line[] = [];
  for (const row of rows) {
    row.runs.sort((a, b) => a.box[0] - b.box[0]);
    let segment: Run[] = [];
    for (const run of row.runs) {
      const previous = segment.at(-1);
      // A large blank is a column/table boundary, not an ordinary word space.
      if (previous && run.box[0] - previous.box[2] > Math.max(row.size * 2, viewport.width * 0.025)) {
        lines.push(makeLine(segment));
        segment = [];
      }
      segment.push(run);
    }
    if (segment.length) lines.push(makeLine(segment));
  }
  return lines.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
}

/** Find a persistent central gutter, ignoring short labels and full-width headings. */
function columnSplit(lines: Line[], pageWidth: number): number | null {
  const body = lines.filter((line) => line.box[2] - line.box[0] >= pageWidth * 0.12);
  let best: number | null = null;
  let bestScore = 0;
  for (let step = 30; step <= 70; step++) {
    const x = pageWidth * step / 100;
    let left = 0;
    let right = 0;
    let crossing = 0;
    for (const line of body) {
      if (line.box[2] <= x) left++;
      else if (line.box[0] >= x) right++;
      else crossing++;
    }
    if (left < 3 || right < 3) continue;
    const score = 2 * Math.min(left, right) - crossing;
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
  if (REF_HEADING.test(line.text) || REF_END.test(line.text) || SECTION_HEADING.test(line.text)) return true;
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

function paragraphs(lines: Line[]): Line[][] {
  if (!lines.length) return [];
  let left = Infinity;
  let right = -Infinity;
  for (const line of lines) {
    left = Math.min(left, line.box[0]);
    right = Math.max(right, line.box[2]);
  }
  const width = right - left;
  const spacings: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i].baseline - lines[i - 1].baseline;
    const size = Math.max(lines[i].size, lines[i - 1].size);
    if (gap > size * 0.7 && gap < size * 2) spacings.push(gap);
  }
  const leading = median(spacings);
  const result: Line[][] = [];
  let current: Line[] = [];
  let paragraphLeft = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const previous = lines[i - 1];
    const heading = isHeading(line, previous, lines[i + 1], width);
    let newParagraph = heading || LIST_START.test(line.text);
    if (previous && current.length) {
      const size = Math.max(line.size, previous.size);
      const gap = line.baseline - previous.baseline;
      const indented = line.box[0] - paragraphLeft > size * 0.7 && !LIST_START.test(current[0].text);
      const shortEnding = !LIST_START.test(current[0].text) &&
        /[.!?:]$/.test(previous.text) && previous.box[2] - previous.box[0] < width * 0.8;
      newParagraph ||= gap > (leading || size * 1.2) * 1.35 || gap <= 0 ||
        Math.abs(line.size - previous.size) > size * 0.18 || indented || shortEnding;
    }
    if (newParagraph && current.length) {
      result.push(current);
      current = [];
      paragraphLeft = Infinity;
    }
    current.push(line);
    paragraphLeft = Math.min(paragraphLeft, line.box[0]);
    if (heading) {
      result.push(current);
      current = [];
      paragraphLeft = Infinity;
    }
  }
  if (current.length) result.push(current);
  return result;
}

/** Geometry-only layout, independent of PDF parsing; accepts genuine PDF.js text-content data. */
export function pageBlocks(page: number, viewport: TextViewport, content: TextContent, firstIndex = 0): Block[] {
  const blocks: Block[] = [];
  for (const region of readingRegions(pageLines(content, viewport), viewport.width)) {
    for (const paragraph of paragraphs(region)) {
      const text = joinLines(paragraph);
      if (!text) continue;
      blocks.push({
        idx: firstIndex + blocks.length,
        page,
        text,
        lines: paragraph.map((line) => line.box),
        pageW: viewport.width,
        pageH: viewport.height,
        isRef: false,
      });
    }
  }
  return blocks;
}
