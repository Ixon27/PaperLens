/**
 * What the PDF can explain: figure/table captions and section headings. The server prompt and the
 * client markers both resolve anchors here, so they always agree on the same block.
 */

export type ExplainType = 'figure' | 'table' | 'section';

/** A block found again by page, kind and the start of its text (block indexes change on re-layout). */
export interface ExplainAnchor {
  type: ExplainType;
  page: number;
  key: string;
}

export interface AnchorBlock {
  page: number;
  text: string;
  kind: string;
  isRef: boolean;
}

export const ANCHOR_KEY_CHARS = 60;

const CAPTION_LABEL = /^(fig(?:ure)?s?|table|scheme|chart|algorithm|listing|그림|표)\.?\s*((?:[A-Z]\.?)?\d+(?:\.\d+)*[A-Za-z]?|[IVX]+[A-Za-z]?)\b/iu;
/** The number part, case-sensitive: "Figure in …" must not read as roman numeral "in". */
const LABEL_NUMBER = /^(?:(?:[A-Z]\.?)?\d+(?:\.\d+)*[A-Za-z]?|[IVX]+[A-Za-z]?)$/u;
/** Headed back matter (and stray front-matter labels): nothing in it to explain. */
const BACK_MATTER_HEADING =
  /^(?:\d+(?:\.\d+)*\.?\s*)?(?:references?(?: and notes)?|literature cited|bibliography|acknowledge?ments?|funding|authors?'? (?:contributions?|affiliations?|information|orcids?)|additional (?:files|information)|ethics(?: approval| statement)?|data availability|code availability|data and code availability|availability of data and materials|reproducibility statement|broader impacts?|declarations?|checklist|conflicts? of interest|competing interests?|supplementary (?:materials?|information)|abbreviations|correspondence)\b/i;

/** `Fig. 2A. Growth…` → `{ figure, 'Figure 2A' }`; supplementary items and prose → null. */
export function captionLabel(text: string): { type: 'figure' | 'table'; label: string } | null {
  const t = text.trim();
  if (/^supplementary\b/i.test(t)) return null;
  const m = CAPTION_LABEL.exec(t);
  if (!m || !LABEL_NUMBER.test(m[2])) return null;
  const word = m[1].toLowerCase();
  const name = word.startsWith('fig') ? 'Figure' : word === 'table' ? 'Table' : word === 'scheme' ? 'Scheme'
    : word === 'chart' ? 'Chart' : word === 'algorithm' ? 'Algorithm' : word === 'listing' ? 'Listing' : word;
  return { type: name === 'Table' || name === '표' ? 'table' : 'figure', label: `${name} ${m[2]}` };
}

export function captionKindName(label: string): string {
  if (/^(?:Table|표)(?:\s|$)/i.test(label)) return '표';
  if (/^Algorithm(?:\s|$)/i.test(label)) return '알고리즘';
  if (/^Listing(?:\s|$)/i.test(label)) return '코드';
  return '그림';
}

/** Body paragraphs under the heading at `at`, up to the next heading; captions and asides are skipped. */
export function sectionBody<T extends AnchorBlock>(blocks: T[], at: number): T[] {
  const out: T[] = [];
  for (let i = at + 1; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind === 'heading') break;
    if (b.kind === 'body' && !b.isRef) out.push(b);
  }
  return out;
}

export function anchorOf<T extends AnchorBlock>(blocks: T[], at: number): ExplainAnchor | null {
  const b = blocks[at];
  if (!b || b.isRef) return null;
  const key = b.text.slice(0, ANCHOR_KEY_CHARS);
  if (b.kind === 'caption') {
    const cap = captionLabel(b.text);
    return cap ? { type: cap.type, page: b.page, key } : null;
  }
  if (b.kind === 'heading' && /\p{L}{3}/u.test(b.text) && !BACK_MATTER_HEADING.test(b.text.trim()) && sectionBody(blocks, at).length) {
    return { type: 'section', page: b.page, key };
  }
  return null;
}

/** Index of the anchored block, or -1. */
export function findAnchor<T extends AnchorBlock>(blocks: T[], a: ExplainAnchor): number {
  const kind = a.type === 'section' ? 'heading' : 'caption';
  return blocks.findIndex((b) => b.page === a.page && b.kind === kind && b.text.startsWith(a.key));
}

/** Stable identity of an anchor (stored in `threads.anchor`). */
export function anchorId(a: ExplainAnchor): string {
  return JSON.stringify({ type: a.type, page: a.page, key: a.key });
}

export function parseAnchor(v: unknown): ExplainAnchor | null {
  if (typeof v !== 'object' || v === null) return null;
  const { type, page, key } = v as Record<string, unknown>;
  if (type !== 'figure' && type !== 'table' && type !== 'section') return null;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) return null;
  if (typeof key !== 'string' || key.length < 1 || key.length > ANCHOR_KEY_CHARS) return null;
  return { type, page, key };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Body-text mentions of a caption label: `Figure 3` matches "Fig. 3" and "Figs 3", never "Fig. 30". */
export function mentionPattern(label: string): RegExp {
  const space = label.indexOf(' ');
  const word = label.slice(0, space);
  const n = escapeRe(label.slice(space + 1));
  if (word === 'Table') return new RegExp(`\\bTables?\\s*${n}(?!\\.?\\d)`, 'i');
  if (word === 'Figure') return new RegExp(`\\bFig(?:ure)?s?\\.?\\s*${n}(?!\\.?\\d)`, 'i');
  if (word === 'Algorithm') return new RegExp(`\\bAlg(?:orithm)?s?\\.?\\s*${n}(?!\\.?\\d)`, 'i');
  if (word === '그림' || word === '표') return new RegExp(`${word}\\s*${n}(?!\\.?\\d)`, 'i');
  return new RegExp(`\\b${escapeRe(word)}s?\\s*${n}(?!\\.?\\d)`, 'i');
}
