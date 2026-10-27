/** Abbreviations that end with a period inside a sentence in scientific English. */
const ABBREV = new Set([
  'al', 'fig', 'figs', 'eq', 'eqs', 'ref', 'refs', 'vs', 'approx', 'ca', 'cf', 'no', 'nos', 'vol', 'dr', 'prof', 'st', 'sp', 'spp', 'lcb',
  'subsp', 'var', 'inc', 'ltd', 'co', 'corp', 'etc', 'resp', 'min', 'max', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep',
  'sept', 'oct', 'nov', 'dec',
]);

/** Sentence end candidates: terminal punctuation, closing quotes/brackets, then whitespace. */
const END = /[.!?]["'”’)\]]*(?=\s)/g;

/** Korean translations also open sentences with Hangul, retaining Latin scientific terms. */
function opensSentence(text: string, at: number, korean: boolean): boolean {
  const c = text[at];
  if (c === undefined) return false;
  if (/[\p{Lu}\d]/u.test(c)) return true;
  if (korean && /\p{Script=Hangul}/u.test(c)) return true;
  if (korean && /^[a-z][A-Za-z\d-]*\p{Script=Hangul}/u.test(text.slice(at))) return true;
  return '“"‘(['.includes(c) && (/\p{Lu}/u.test(text[at + 1] ?? '') || (korean && /\p{Script=Hangul}/u.test(text[at + 1] ?? '')));
}

/** Scientific abbreviations stay inside a sentence; numeric values and unit-ending periods may close it. */
function blocksBoundary(word: string, prefix: string): boolean {
  if (/^\d+(?:\.\d+)+$/.test(word)) return false;
  if (/^[CF]$/.test(word) && /\d\s*[°◦]\s*$/.test(prefix)) return false;
  if (word.toLowerCase() === 'min' && /\d\s*$/.test(prefix)) return false;
  if (/^\p{Lu}$/u.test(word)) return true;
  if (word.slice(0, -1).includes('.')) return true;
  return ABBREV.has(word.toLowerCase().replace(/\.$/, ''));
}

function sentenceRanges(text: string, korean: boolean): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const push = (start: number, end: number) => {
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (start < end) ranges.push([start, end]);
  };
  let start = 0;
  for (const m of text.matchAll(END)) {
    const end = m.index + m[0].length;
    let next = end;
    while (next < text.length && /\s/.test(text[next])) next++;
    if (!opensSentence(text, next, korean)) continue;
    const word = /[\p{L}\p{N}.]*$/u.exec(text.slice(0, m.index))![0];
    const prefix = text.slice(start, m.index - word.length);
    // Leading numeric labels ("1. Introduction", "2.1. Methods") belong to their heading.
    if (/^\d+(?:\.\d+)*$/.test(word) && !prefix.trim()) continue;
    if (word && blocksBoundary(word, prefix)) continue;
    push(start, end);
    start = next;
  }
  push(start, text.length);
  return ranges.length ? ranges : [[0, text.length]];
}

/**
 * Sentence ranges `[start, end)` of English paper text, trimmed of whitespace. Text without a
 * sentence boundary is one range.
 */
export function splitSentences(text: string): Array<[number, number]> {
  return sentenceRanges(text, false);
}

/** Korean sentence ranges with the same scientific abbreviation and numeric-prefix handling. */
export function splitKoreanSentences(text: string): Array<[number, number]> {
  return sentenceRanges(text, true);
}
