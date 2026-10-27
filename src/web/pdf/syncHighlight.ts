import type { BlockDto } from '../types';

/**
 * PDF.js draws one span per text item with non-empty `str`, in content order, directly in the
 * text layer or inside its `markedContent` spans; block `spans` index into that list. The spans
 * are matched by position, not `role="presentation"`: PDF.js drops that role from spans that
 * own a link annotation. The highlighter's own layer, also inside the text layer, is skipped.
 */
const ITEM_SPANS = ':scope > span:not(.markedContent), :scope .markedContent > span:not(.markedContent)';
const HIGHLIGHT_NAME = 'pr-sync';

function itemSpans(page: number): HTMLElement[] | null {
  const layer = document.querySelector(`.pdf-pane .page[data-page-number="${page}"] .textLayer`);
  return layer ? [...layer.querySelectorAll<HTMLElement>(ITEM_SPANS)].filter((el) => !el.closest('.PdfHighlighter__highlight-layer')) : null;
}

const compact = (t: string) => t.normalize('NFKC').replace(/\s+/g, '');

/** The item span drawing `expected`: normally at `item`; nearby when the viewer's item list differs slightly. */
function findSpan(list: HTMLElement[], item: number, expected: string): HTMLElement | null {
  const head = compact(expected).slice(0, 3);
  const fits = (el: HTMLElement | undefined) => el !== undefined && compact(el.textContent ?? '').startsWith(head);
  if (fits(list[item])) return list[item];
  for (let d = 1; d <= 5; d++) {
    if (fits(list[item - d])) return list[item - d];
    if (fits(list[item + d])) return list[item + d];
  }
  return null;
}

/** DOM ranges covering `block.text[start, end)` in the rendered text layer (pages not rendered yet are skipped). */
export function rangesFor(block: BlockDto, start: number, end: number): Range[] {
  const pages = new Map<number, HTMLElement[] | null>();
  const ranges: Range[] = [];
  for (const [page, item, s, e] of block.spans) {
    if (e <= start || s >= end) continue;
    if (!pages.has(page)) pages.set(page, itemSpans(page));
    const list = pages.get(page);
    if (!list) continue;
    const expected = block.text.slice(s, e);
    const node = findSpan(list, item, expected)?.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) continue;
    const dom = node.textContent ?? '';
    // Block text drops a line's leading spaces; the span keeps them.
    const base = /^\s/.test(expected) ? 0 : dom.length - dom.trimStart().length;
    const normalized = dom.slice(base).normalize('NFKC');
    const expectedNormalized = expected.normalize('NFKC');
    let a: number;
    let b: number;
    if (normalized.startsWith(expectedNormalized)) {
      // PDF.js can draw a ligature as one character while extracted block text has two.
      // Map normalized characters back to their actual DOM boundaries rather than scaling.
      const starts: number[] = [];
      const ends: number[] = [];
      for (let i = base; i < dom.length;) {
        const char = String.fromCodePoint(dom.codePointAt(i)!);
        const finish = i + char.length;
        for (let j = 0; j < char.normalize('NFKC').length; j++) {
          starts.push(i);
          ends.push(finish);
        }
        i = finish;
      }
      const offset = (pos: number) => expected.slice(0, pos - s).normalize('NFKC').length;
      const startOffset = offset(Math.max(start, s));
      const endOffset = offset(Math.min(end, e));
      a = starts[startOffset] ?? dom.length;
      b = endOffset ? ends[endOffset - 1] ?? dom.length : base;
    } else {
      const len = dom.length - base;
      const scale = Math.abs(len - (e - s)) <= 1 ? 1 : len / (e - s);
      const at = (pos: number) => Math.min(dom.length, Math.max(0, base + Math.round((pos - s) * scale)));
      a = at(Math.max(start, s));
      b = at(Math.min(end, e));
    }
    if (a >= b) continue;
    const range = document.createRange();
    range.setStart(node, a);
    range.setEnd(node, b);
    ranges.push(range);
  }
  return ranges;
}

/** Paint the synced sentence with the CSS Custom Highlight API (no DOM changes to the text layer). */
export function showSync(ranges: Range[]): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;
  if (ranges.length) CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
  else CSS.highlights.delete(HIGHLIGHT_NAME);
}

/** Paint a cited source passage independently of translation hover highlights. */
export function showSource(ranges: Range[]): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;
  if (ranges.length) CSS.highlights.set('pr-source', new Highlight(...ranges));
  else CSS.highlights.delete('pr-source');
}

/** The text-layer item and character under the pointer, if any. `length` is the item's text length. */
export function hitTest(x: number, y: number): { page: number; item: number; offset: number; length: number } | null {
  let node: Node | null = null;
  let offset = 0;
  if (typeof document.caretPositionFromPoint === 'function') {
    const p = document.caretPositionFromPoint(x, y);
    if (p) {
      node = p.offsetNode;
      offset = p.offset;
    }
  } else if (typeof document.caretRangeFromPoint === 'function') {
    const r = document.caretRangeFromPoint(x, y);
    if (r) {
      node = r.startContainer;
      offset = r.startOffset;
    }
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const el = node.parentElement;
  const layer = el?.closest('.pdf-pane .textLayer');
  if (!el || !layer || el.tagName !== 'SPAN' || el.classList.contains('markedContent')) return null;
  const page = Number(el.closest<HTMLElement>('.page')?.dataset.pageNumber);
  if (!page) return null;
  const item = itemSpans(page)?.indexOf(el) ?? -1;
  if (item < 0) return null;
  const text = node.textContent ?? '';
  const lead = text.length - text.trimStart().length;
  return { page, item, offset: Math.max(0, offset - lead), length: text.length - lead };
}
