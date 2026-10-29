import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { isFieldId, type FieldId } from '../../shared/fields';
import { PATHS } from '../config';
import { db, getArtifact, getPaper, isTranslatable, madeByOf, now, parseAuthors, refreshFts, type BlockRow, type PaperRow } from '../db';
import { latestJobs, snapshotOf, type JobRow } from '../jobs';
import * as openalex from '../services/openalex';
import { HttpError } from '../http-error';
import { orderSections } from '../tasks/analysis';
import { attachPdf, ensureCurrentLayout, importFromInput, importUpload, normalizeDoi, paperIdByDoi, retryPaperPdf } from '../tasks/import';
import { ensureTranslationSentences } from '../tasks/translation-alignment';
import { deletePaper } from '../tasks/delete-paper';
import { suggestField, type FieldSuggestion } from '../tasks/suggest-field';
import type { MadeBy } from '../../shared/models';

export const papers = new Hono();

function fieldInput(v: unknown): FieldId | null {
  if (v === undefined || v === null || v === '' || v === 'auto') return null;
  if (isFieldId(v)) return v;
  throw new HttpError(400, '알 수 없는 분야입니다');
}

const fieldSuggestions = new Map<string, Promise<FieldSuggestion>>();

export function paperStatus(paperId: string) {
  const blocks = db.prepare('SELECT is_ref, text, kind FROM blocks WHERE paper_id=?').all(paperId) as Pick<BlockRow, 'is_ref' | 'text' | 'kind'>[];
  const done = (db.prepare('SELECT COUNT(*) AS n FROM translations WHERE paper_id=?').get(paperId) as { n: number }).n;
  const kinds = new Set(
    (db.prepare('SELECT kind FROM artifacts WHERE paper_id=?').all(paperId) as { kind: string }[]).map((r) => r.kind),
  );
  return {
    analysis: kinds.has('analysis'),
    mindmap: kinds.has('mindmap'),
    translation: { done, total: blocks.filter(isTranslatable).length },
    blockCount: blocks.length,
  };
}

const jobDto = (j: JobRow | undefined | null) =>
  j ? { id: j.id, kind: j.kind, status: j.status, progress: j.progress, message: j.message, error: j.error } : null;

function paperDto(p: PaperRow) {
  const jobs = latestJobs(p.id);
  const running = jobs.find((j) => j.status === 'running' || j.status === 'queued');
  const importJob = jobs.find((j) => j.kind === 'import');
  return {
    id: p.id,
    title: p.title,
    authors: parseAuthors(p),
    year: p.year,
    journal: p.journal,
    volume: p.volume,
    issue: p.issue,
    pages: p.pages,
    doi: p.doi,
    arxivId: p.arxiv_id,
    openalexId: p.openalex_id,
    hasPdf: Boolean(p.pdf_file),
    pageCount: p.page_count,
    field: isFieldId(p.field) ? p.field : null,
    fieldSuggested: isFieldId(p.field_suggested) ? p.field_suggested : null,
    createdAt: p.created_at,
    lastOpenedAt: p.last_opened_at,
    status: paperStatus(p.id),
    // Running job first; otherwise the latest import job so its final message (e.g. "no OA PDF") stays visible.
    job: jobDto(running ?? (importJob && !p.pdf_file ? importJob : null)),
  };
}

papers.get('/papers', (c) => {
  const q = c.req.query('q')?.trim();
  let rows: PaperRow[];
  const order = 'ORDER BY p.last_opened_at DESC NULLS LAST, p.created_at DESC';
  if (q) {
    const match = q
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '""')}"*`)
      .join(' AND ');
    rows = db
      .prepare(`SELECT p.* FROM papers p JOIN papers_fts f ON f.paper_id = p.id WHERE papers_fts MATCH ? ${order}`)
      .all(match) as unknown as PaperRow[];
  } else {
    rows = db.prepare(`SELECT p.* FROM papers p ${order}`).all() as unknown as PaperRow[];
  }
  return c.json(rows.map(paperDto));
});

papers.post('/papers/import', async (c) => {
  const { input, field } = await c.req.json<{ input?: string; field?: unknown }>();
  if (!input?.trim()) throw new HttpError(400, 'DOI, arXiv 또는 OpenAlex 링크가 아닙니다');
  return c.json(await importFromInput(input, fieldInput(field)));
});

papers.post('/papers/:id/pdf/fetch', (c) => c.json(retryPaperPdf(c.req.param('id'))));

papers.post('/papers/upload', async (c) => {
  const body = await c.req.parseBody({ all: true });
  const raw = body['file'];
  const files = (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File);
  if (!files.length) throw new HttpError(400, 'PDF 파일이 없습니다');
  const field = fieldInput(body['field']);
  const results = [];
  for (const f of files) {
    try {
      results.push(await importUpload(f.name, Buffer.from(await f.arrayBuffer()), field));
    } catch (e) {
      results.push({ name: f.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return c.json(results);
});

function requirePaper(id: string): PaperRow {
  const p = getPaper(id);
  if (!p) throw new HttpError(404, '논문을 찾을 수 없습니다');
  return p;
}

papers.get('/papers/:id', (c) => {
  const p = requirePaper(c.req.param('id'));
  db.prepare('UPDATE papers SET last_opened_at=? WHERE id=?').run(now(), p.id);
  return c.json({ ...paperDto(p), abstract: p.abstract });
});

papers.put('/papers/:id/field', async (c) => {
  const paper = requirePaper(c.req.param('id'));
  const { field } = await c.req.json<{ field?: unknown }>();
  if (!isFieldId(field)) throw new HttpError(400, '분야를 고르세요');
  db.prepare('UPDATE papers SET field=?, updated_at=? WHERE id=?').run(field, now(), paper.id);
  const updated = getPaper(paper.id)!;
  return c.json({ ...paperDto(updated), abstract: updated.abstract });
});

papers.post('/papers/:id/field/suggest', async (c) => {
  const paper = requirePaper(c.req.param('id'));
  if (isFieldId(paper.field_suggested)) return c.json({ suggested: paper.field_suggested, engine: null, skipped: [] } satisfies FieldSuggestion);
  let pending = fieldSuggestions.get(paper.id);
  if (!pending) {
    pending = suggestField(paper).finally(() => fieldSuggestions.delete(paper.id));
    fieldSuggestions.set(paper.id, pending);
  }
  try {
    return c.json(await pending);
  } catch (e) {
    throw new HttpError(502, e instanceof Error ? e.message : String(e));
  }
});

papers.patch('/papers/:id', async (c) => {
  const p = requirePaper(c.req.param('id'));
  const body = await c.req.json<{
    title?: string;
    authors?: { family: string; given?: string }[];
    year?: number | null;
    journal?: string | null;
    volume?: string | null;
    issue?: string | null;
    pages?: string | null;
    doi?: string | null;
  }>();
  const doi = body.doi === undefined ? p.doi : body.doi?.trim() ? normalizeDoi(body.doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')) : null;
  if (doi && doi !== p.doi) {
    const other = paperIdByDoi(doi);
    if (other && other !== p.id) throw new HttpError(409, '다른 논문이 이미 이 DOI를 씁니다');
  }
  const pick = <T>(v: T | undefined, cur: T) => (v === undefined ? cur : v);
  const blank = (v: string | null | undefined) => (typeof v === 'string' && !v.trim() ? null : v);
  const title = body.title?.trim() || p.title;
  const authors = body.authors
    ? JSON.stringify(body.authors.filter((a) => a.family?.trim()).map((a) => ({ family: a.family.trim(), given: a.given?.trim() || undefined })))
    : p.authors;
  let ids = { openalex_id: p.openalex_id, pmid: p.pmid, pmcid: p.pmcid };
  if (doi && doi !== p.doi && !p.openalex_id) {
    const w = await openalex.getByDoi(doi).catch(() => null);
    if (w) {
      const s = openalex.toSummary(w);
      ids = { openalex_id: s.openalexId, pmid: s.pmid, pmcid: s.pmcid };
    }
  }
  db.prepare(
    `UPDATE papers SET title=?, authors=?, year=?, journal=?, volume=?, issue=?, pages=?, doi=?, openalex_id=?, pmid=?, pmcid=?, updated_at=? WHERE id=?`,
  ).run(
    title,
    authors,
    pick(body.year, p.year),
    pick(blank(body.journal), p.journal),
    pick(blank(body.volume), p.volume),
    pick(blank(body.issue), p.issue),
    pick(blank(body.pages), p.pages),
    doi,
    ids.openalex_id,
    ids.pmid,
    ids.pmcid,
    now(),
    p.id,
  );
  refreshFts(p.id);
  return c.json({ ...paperDto(getPaper(p.id)!), abstract: p.abstract });
});

papers.delete('/papers/:id', (c) => {
  deletePaper(requirePaper(c.req.param('id')));
  return c.json({ ok: true });
});

papers.get('/papers/:id/pdf', (c) => {
  const p = requirePaper(c.req.param('id'));
  const file = p.pdf_file ? join(PATHS.pdfs, p.pdf_file) : null;
  if (!file || !existsSync(file)) throw new HttpError(404, 'PDF가 없습니다');
  return c.body(readFileSync(file), 200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-cache' });
});

papers.post('/papers/:id/pdf', async (c) => {
  const p = requirePaper(c.req.param('id'));
  const body = await c.req.parseBody();
  const f = body['file'];
  if (!(f instanceof File)) throw new HttpError(400, 'PDF 파일이 없습니다');
  return c.json({ jobId: attachPdf(p.id, Buffer.from(await f.arrayBuffer())) });
});

papers.get('/papers/:id/blocks', async (c) => {
  const p = requirePaper(c.req.param('id'));
  // Upgrade reading metadata without discarding existing translations.
  await ensureCurrentLayout(p.id);
  ensureTranslationSentences(p.id);
  const rows = db
    .prepare(
      `SELECT b.*, t.ko, t.sentences AS ko_sentences, t.made_by AS ko_by FROM blocks b
       LEFT JOIN translations t ON t.paper_id=b.paper_id AND t.block_idx=b.idx
       WHERE b.paper_id=? ORDER BY b.idx`,
    )
    .all(p.id) as unknown as (BlockRow & { ko: string | null; ko_sentences: string | null; ko_by: string | null })[];
  return c.json(
    rows.map((b) => ({
      idx: b.idx,
      page: b.page,
      text: b.text,
      lines: JSON.parse(b.lines) as number[][],
      pageW: b.page_w,
      pageH: b.page_h,
      isRef: Boolean(b.is_ref),
      kind: b.kind,
      translatable: isTranslatable(b),
      spans: JSON.parse(b.spans) as number[][],
      ko: b.ko,
      koSentences: b.ko_sentences
        ? (JSON.parse(b.ko_sentences) as [number, number, string][]).map(([start, end, ko]) => ({ start, end, ko }))
        : null,
      by: b.ko_by ? (JSON.parse(b.ko_by) as MadeBy) : null,
    })),
  );
});

papers.get('/papers/:id/jobs', (c) => {
  const p = requirePaper(c.req.param('id'));
  return c.json(latestJobs(p.id).map((j) => snapshotOf(j)));
});

papers.get('/papers/:id/artifacts/:kind', (c) => {
  const p = requirePaper(c.req.param('id'));
  const kind = c.req.param('kind');
  const a = getArtifact(p.id, kind);
  if (!a) throw new HttpError(404, '아직 없습니다');
  // Analyses made before a section rename read under the current names.
  const content = kind === 'analysis' ? orderSections([a.content]) : a.content;
  return c.json({ content, meta: JSON.parse(a.meta) as unknown, by: madeByOf(a), updatedAt: a.updated_at });
});

export { requirePaper };
