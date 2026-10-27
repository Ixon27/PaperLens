import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { db, getBlocks, now, type PaperRow } from '../db';
import { HttpError } from '../http-error';
import { parseJsonLoose } from '../json';
import { resolveModel, runLlm } from '../llm';
import { abstractOrPageOne } from '../pdf/context';
import { fill, loadPrompt } from '../prompts';
import { startKeywords } from '../tasks/keywords';
import { cleanTerm, termDto, termKey, type TermDto, type TermRow } from '../terms';
import { requirePaper } from './papers';

export const terms = new Hono();

const JSON_ONLY = '\n\n(설명 없이 JSON 객체 하나만 출력하라.)';
const CONTEXT_CHARS = 1500;

const byKey = (paperId: string, key: string) =>
  db.prepare('SELECT * FROM terms WHERE paper_id=? AND term_key=?').get(paperId, key) as TermRow | undefined;

/** The paragraph the term was read in: on its page if possible, else anywhere in the reading text. */
function surroundingOf(paperId: string, term: string, page: number | null): string {
  const needle = term.toLowerCase();
  const reading = getBlocks(paperId).filter((b) => b.kind !== 'aside' && b.text.replace(/\s+/g, ' ').toLowerCase().includes(needle));
  return ((page !== null && reading.find((b) => b.page === page)) || reading[0])?.text.slice(0, CONTEXT_CHARS) ?? '';
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

async function explain(paper: PaperRow, term: string, key: string, page: number | null): Promise<TermDto> {
  const P = loadPrompt('terms');
  const system = fill(P.SYSTEM, { title: paper.title, abstract: abstractOrPageOne(paper) });
  const prompt = fill(P.PROMPT, { term, surrounding: surroundingOf(paper.id, term, page) });
  const by = resolveModel('quick');
  let parsed: { ko: string; definition: string; inPaper: string } | null = null;
  for (const p of [prompt, prompt + JSON_ONLY]) {
    let text: string;
    try {
      ({ text } = await runLlm({ system, prompt: p, profile: 'quick', model: by }));
    } catch (e) {
      throw new HttpError(502, e instanceof Error ? e.message : '용어 설명을 만들지 못했습니다');
    }
    try {
      const o = parseJsonLoose<Record<string, unknown>>(text);
      if (str(o.definition)) {
        parsed = { ko: str(o.ko), definition: str(o.definition), inPaper: str(o.inPaper) };
        break;
      }
    } catch {
      // retry once with the JSON-only suffix
    }
  }
  if (!parsed) throw new HttpError(502, '용어 설명을 만들지 못했습니다');
  db.prepare(
    `INSERT INTO terms(id,paper_id,term,term_key,ko,definition,in_paper,page,made_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(paper_id,term_key) DO NOTHING`,
  ).run(nanoid(12), paper.id, term, key, parsed.ko || term, parsed.definition, parsed.inPaper, page, JSON.stringify(by), now());
  return termDto(byKey(paper.id, key)!);
}

/** Concurrent lookups of the same term share one CLI call. */
const inFlight = new Map<string, Promise<TermDto>>();

terms.get('/papers/:id/terms', (c) => {
  const p = requirePaper(c.req.param('id'));
  const rows = db
    .prepare("SELECT * FROM terms WHERE paper_id=? ORDER BY CASE source WHEN 'auto' THEN 0 ELSE 1 END, created_at, rowid")
    .all(p.id) as unknown as TermRow[];
  return c.json(rows.map(termDto));
});

/** (Re)generate the paper's core terms for the 키워드 사전; returns the job id. */
terms.post('/papers/:id/keywords', (c) => c.json({ jobId: startKeywords(requirePaper(c.req.param('id')).id) }));

terms.post('/papers/:id/terms', async (c) => {
  const paper = requirePaper(c.req.param('id'));
  const body = await c.req.json<{ term?: unknown; page?: unknown }>().catch(() => ({}) as { term?: unknown; page?: unknown });
  const term = typeof body.term === 'string' ? cleanTerm(body.term) : '';
  if (!term || term.length > 80) throw new HttpError(400, '용어는 80자 이내로 선택하세요');
  const page = typeof body.page === 'number' && Number.isInteger(body.page) && body.page > 0 ? body.page : null;
  const key = termKey(term);
  const saved = byKey(paper.id, key);
  if (saved) return c.json(termDto(saved));

  const flight = `${paper.id}:${key}`;
  let pending = inFlight.get(flight);
  if (!pending) {
    pending = explain(paper, term, key, page).finally(() => inFlight.delete(flight));
    inFlight.set(flight, pending);
  }
  return c.json(await pending);
});

terms.delete('/terms/:tid', (c) => {
  const r = db.prepare('DELETE FROM terms WHERE id=?').run(c.req.param('tid'));
  if (!r.changes) throw new HttpError(404, '용어를 찾을 수 없습니다');
  return c.json({ ok: true });
});
