import { nanoid } from 'nanoid';
import { db, now, tx } from './db';
import type { MadeBy, ModelSpec } from '../shared/models';

/** `auto`: one of the paper's core terms picked by the keywords job; `lookup`: a term the reader looked up. */
export type TermSource = 'auto' | 'lookup';

export interface TermRow {
  id: string;
  paper_id: string;
  term: string;
  term_key: string;
  ko: string;
  definition: string;
  in_paper: string;
  page: number | null;
  made_by: string | null;
  created_at: string;
  source: TermSource;
}

export interface TermDto {
  id: string;
  term: string;
  ko: string;
  definition: string;
  inPaper: string;
  page: number | null;
  by: MadeBy | null;
  createdAt: string;
  source: TermSource;
}

const OPEN_BRACKETS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSE_BRACKETS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const EDGE_PUNCT = /^[\p{P}\s]+|[\p{P}\s]+$/gu;

function balancedBrackets(value: string): boolean {
  const stack: string[] = [];
  for (const char of value) {
    if (OPEN_BRACKETS[char]) stack.push(char);
    else if (CLOSE_BRACKETS[char] && stack.pop() !== CLOSE_BRACKETS[char]) return false;
  }
  return stack.length === 0;
}

// Earlier versions removed closing punctuation before saving AI keywords.
// Repair only a trailing, unfinished parenthesized token for display; retain
// the stored value and key so existing lookups and user entries are unchanged.
function displayedTerm(r: TermRow): string {
  if (r.source !== 'auto') return r.term;
  const open = r.term.lastIndexOf('(');
  if (open < 0 || !balancedBrackets(r.term.slice(0, open))) return r.term;
  const suffix = r.term.slice(open + 1);
  return /^[\p{L}\p{N}][\p{L}\p{N}_.:+/−-]*$/u.test(suffix) ? `${r.term})` : r.term;
}

export const termDto = (r: TermRow): TermDto => {
  const term = displayedTerm(r);
  return {
    id: r.id,
    term,
    ko: r.ko === r.term ? term : r.ko,
    definition: r.definition,
    inPaper: r.in_paper,
    page: r.page,
    by: r.made_by ? (JSON.parse(r.made_by) as MadeBy) : null,
    createdAt: r.created_at,
    source: r.source,
  };
};

export function cleanTerm(t: string): string {
  let term = t.normalize('NFKC').replace(/\s+/g, ' ').trim();
  while (term && /^\p{P}/u.test(term)) {
    const closing = OPEN_BRACKETS[term[0]];
    if (closing && term.slice(1).includes(closing)) break;
    term = term.slice(1).trimStart();
  }
  while (term && /\p{P}$/u.test(term)) {
    const opening = CLOSE_BRACKETS[term[term.length - 1]];
    if (opening && term.slice(0, -1).includes(opening)) break;
    term = term.slice(0, -1).trimEnd();
  }
  return term;
}

/** Preserve existing keys while allowing balanced punctuation in displayed terms. */
export const termKey = (t: string) => cleanTerm(t).replace(EDGE_PUNCT, '').toLowerCase();

export interface KeywordEntry {
  term: string;
  ko: string;
  definition: string;
  inPaper: string;
}

const MAX_KEYWORDS = 15;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** The keywords job's JSON array → at most 15 distinct, defined terms of 1–80 characters. */
export function normalizeKeywords(value: unknown): KeywordEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: KeywordEntry[] = [];
  for (const item of value) {
    if (out.length >= MAX_KEYWORDS) break;
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const rawTerm = typeof o.term === 'string' ? o.term.normalize('NFKC') : '';
    const term = cleanTerm(rawTerm);
    const definition = str(o.definition);
    if (!term || term.length > 80 || !definition || !/[\p{L}\p{N}]/u.test(term) || !balancedBrackets(rawTerm) || /\(\s*\)|\[\s*\]|\{\s*\}/u.test(rawTerm)) continue;
    const key = termKey(term);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ term, ko: str(o.ko), definition, inPaper: str(o.inPaper) });
  }
  return out;
}

/** Replace the paper's AI-picked terms; a term the reader already looked up keeps its entry. */
export function replaceAutoKeywords(paperId: string, entries: KeywordEntry[], by: ModelSpec): void {
  tx(() => {
    db.prepare("DELETE FROM terms WHERE paper_id=? AND source='auto'").run(paperId);
    const insert = db.prepare(
      `INSERT INTO terms(id,paper_id,term,term_key,ko,definition,in_paper,page,made_by,created_at,source) VALUES(?,?,?,?,?,?,?,NULL,?,?,'auto')
       ON CONFLICT(paper_id,term_key) DO NOTHING`,
    );
    const madeBy = JSON.stringify(by);
    const at = now();
    for (const e of entries) insert.run(nanoid(12), paperId, e.term, termKey(e.term), e.ko || e.term, e.definition, e.inPaper, madeBy, at);
  });
}
