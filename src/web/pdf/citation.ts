export type CiteHit = { kind: 'numeric'; keys: string[] } | { kind: 'author'; family: string; year: string };

const MAX_RANGE = 30;

/** "3–5, 8" → ['3','4','5','8']; null when a single range spans more than 30 numbers. */
function expandKeys(list: string): string[] | null {
  const keys: string[] = [];
  for (const part of list.split(',')) {
    const m = /^\s*(\d{1,4})\s*(?:[–\-−]\s*(\d{1,4}))?\s*$/.exec(part);
    if (!m) return null;
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    if (a === 0 || b < a) return null;
    if (b - a + 1 > MAX_RANGE) return null;
    for (let n = a; n <= b; n++) keys.push(String(n));
  }
  return keys.length ? keys : null;
}

const BRACKET_RE = /\[\s*(\d{1,4}(?:\s*[–\-−,]\s*\d{1,4})*)\s*\]/g;
const PAREN_RE = /\(\s*(\d{1,4}(?:\s*[–\-−,]\s*\d{1,4})*)\s*\)/g;
const NOT_CITE_BEFORE = /(?:eqs?\.?|eqns?\.?|equations?|fig(?:ure)?s?\.?|tables?|sec(?:tion)?s?\.?|thm\.?|theorem|lemma|step)\s*$/i;
const AUTHOR_RE = /(\p{Lu}[\p{L}'’\-]+)(?:\s+et\s+al\.?|\s+(?:and|&)\s+\p{Lu}[\p{L}'’\-]+)?,?\s+\(?((?:1[5-9]|20)\d{2})[a-z]?\)?/gu;

/** The citation (numeric `[3–5]` or author-year `Smith et al., 2020`) whose match contains `offset`. */
export function detectCitation(text: string, offset: number, opts: { parens: boolean }): CiteHit | null {
  for (const m of text.matchAll(BRACKET_RE)) {
    const start = m.index;
    if (offset >= start && offset < start + m[0].length) {
      const keys = expandKeys(m[1]);
      return keys ? { kind: 'numeric', keys } : null;
    }
  }
  if (opts.parens) {
    for (const m of text.matchAll(PAREN_RE)) {
      const start = m.index;
      if (offset >= start && offset < start + m[0].length) {
        if (NOT_CITE_BEFORE.test(text.slice(Math.max(0, start - 12), start))) return null;
        const keys = expandKeys(m[1]);
        return keys ? { kind: 'numeric', keys } : null;
      }
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
  if (!/^\d{1,4}(?:[,–\-−]\d{1,4})*$/.test(t)) return null;
  return expandKeys(t);
}
