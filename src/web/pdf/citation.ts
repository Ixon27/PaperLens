export type CiteHit = { kind: 'numeric'; keys: string[] } | { kind: 'author'; family: string; year: string };

const MAX_RANGE = 30;

/** "3–5, 8" → ['3','4','5','8']; null when a single range spans more than 30 numbers. */
function expandKeys(list: string): string[] | null {
  const keys: string[] = [];
  for (const part of list.split(',')) {
    const m = /^\s*(\d{1,3})\s*(?:[–\-]\s*(\d{1,3}))?\s*$/.exec(part);
    if (!m) return null;
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    if (b < a) return null;
    if (b - a + 1 > MAX_RANGE) return null;
    for (let n = a; n <= b; n++) keys.push(String(n));
  }
  return keys.length ? keys : null;
}

const NUMERIC_RE = /[\[(]\s*(\d{1,3}(?:\s*[–\-,]\s*\d{1,3})*)\s*[\])]/g;
const AUTHOR_RE = /([A-Z][A-Za-zÀ-ÿ'’\-]+)(?:\s+et\s+al\.?|\s+(?:and|&)\s+[A-Z][A-Za-zÀ-ÿ'’\-]+)?,?\s+\(?((?:19|20)\d{2})[a-z]?\)?/g;

/** The citation (numeric `[3–5]` or author-year `Smith et al., 2020`) whose match contains `offset`. */
export function detectCitation(text: string, offset: number): CiteHit | null {
  for (const m of text.matchAll(NUMERIC_RE)) {
    const start = m.index;
    if (offset >= start && offset < start + m[0].length) {
      const keys = expandKeys(m[1]);
      return keys ? { kind: 'numeric', keys } : null;
    }
  }
  for (const m of text.matchAll(AUTHOR_RE)) {
    const start = m.index;
    if (offset >= start && offset < start + m[0].length) return { kind: 'author', family: m[1], year: m[2] };
  }
  return null;
}

/** Superscript citation spans like "12,14" or "3–5". */
export function detectBareNumber(spanText: string): string[] | null {
  const t = spanText.trim();
  if (!/^\d{1,3}(?:[,–\-]\d{1,3})*$/.test(t)) return null;
  return expandKeys(t);
}
