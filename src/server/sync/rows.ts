import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { PATHS } from '../config';
import type { SQLInputValue } from 'node:sqlite';
import { db, now } from '../db';

/** The `image_file` column of the first matching row. */
function imageFileOf(sql: string, ...params: SQLInputValue[]): string | null {
  const row = db.prepare(sql).get(...params);
  return typeof row?.image_file === 'string' ? row.image_file : null;
}

const removeImageFile = (file: string | null) => {
  if (file) rmSync(join(PATHS.images, file), { force: true });
};

/** Everything a paper carries across devices. Blocks are re-extracted from the PDF instead. */
export const ENTITIES = ['paper', 'thread', 'message', 'highlight', 'artifact', 'figure', 'term', 'translation'] as const;
export type Entity = (typeof ENTITIES)[number];
export type RowData = Record<string, unknown>;
export type PaperRows = Map<Entity, Map<string, RowData>>;
/** Files a row points at, by sha256: the PDF and attached images. */
export type BlobSources = Map<string, string>;

/** The 7-day related-papers cache stays on each device. */
const LOCAL_ONLY_ARTIFACTS: Record<string, true> = { related: true };

export const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
export const rowHash = (data: RowData) => sha1(JSON.stringify(data));

/** sha256 of a file, cached by size and mtime (PDFs are hashed once, not on every sync). */
export function fileSha256(path: string): string | null {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  const cached = db.prepare('SELECT size, mtime, sha256 FROM sync_file_hashes WHERE path=?').get(path) as
    | { size: number; mtime: number; sha256: string }
    | undefined;
  if (cached && cached.size === st.size && cached.mtime === st.mtimeMs) return cached.sha256;
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  db.prepare('INSERT INTO sync_file_hashes(path,size,mtime,sha256) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, sha256=excluded.sha256')
    .run(path, st.size, st.mtimeMs, sha256);
  return sha256;
}

function blobOf(path: string | null, sources: BlobSources): string | null {
  if (!path) return null;
  const sha = fileSha256(path);
  if (sha) sources.set(sha, path);
  return sha;
}

const image = (file: string | null) => (file ? join(PATHS.images, file) : null);

/** The paper's current syncable state; key order inside each object is fixed so hashes are stable. */
export function readPaperRows(paperId: string, sources: BlobSources): PaperRows {
  const rows: PaperRows = new Map(ENTITIES.map((e) => [e, new Map()]));
  const p = db.prepare('SELECT * FROM papers WHERE id=?').get(paperId) as Record<string, unknown> | undefined;
  if (!p) return rows;
  rows.get('paper')!.set('_', {
    title: p.title, authors: p.authors, year: p.year, journal: p.journal, volume: p.volume, issue: p.issue, pages: p.pages,
    doi: p.doi, arxiv_id: p.arxiv_id, openalex_id: p.openalex_id, pmid: p.pmid, pmcid: p.pmcid, abstract: p.abstract,
    field: p.field, field_suggested: p.field_suggested, created_at: p.created_at,
    pdf: blobOf(p.pdf_file ? join(PATHS.pdfs, p.pdf_file as string) : null, sources),
  });
  for (const t of db.prepare('SELECT * FROM threads WHERE paper_id=?').all(paperId) as Record<string, unknown>[]) {
    rows.get('thread')!.set(t.id as string, { title: t.title, model: t.model, kind: t.kind, anchor: t.anchor, created_at: t.created_at });
  }
  for (const m of db.prepare('SELECT m.* FROM messages m JOIN threads t ON t.id=m.thread_id WHERE t.paper_id=?').all(paperId) as Record<string, unknown>[]) {
    rows.get('message')!.set(m.id as string, {
      thread_id: m.thread_id, role: m.role, action: m.action, content: m.content, quote: m.quote, page: m.page,
      image: blobOf(image(m.image_file as string | null), sources), engine: m.engine, made_by: m.made_by, created_at: m.created_at,
    });
  }
  for (const h of db.prepare('SELECT * FROM highlights WHERE paper_id=?').all(paperId) as Record<string, unknown>[]) {
    rows.get('highlight')!.set(h.id as string, {
      type: h.type, color: h.color, position: h.position, text: h.text, image: blobOf(image(h.image_file as string | null), sources),
      note: h.note, created_at: h.created_at, updated_at: h.updated_at,
    });
  }
  for (const a of db.prepare('SELECT * FROM artifacts WHERE paper_id=?').all(paperId) as Record<string, unknown>[]) {
    if (LOCAL_ONLY_ARTIFACTS[a.kind as string]) continue;
    rows.get('artifact')!.set(a.kind as string, { content: a.content, meta: a.meta, engine: a.engine, made_by: a.made_by, updated_at: a.updated_at });
  }
  for (const f of db.prepare('SELECT * FROM figures WHERE paper_id=?').all(paperId) as Record<string, unknown>[]) {
    rows.get('figure')!.set(f.anchor as string, { spec: f.spec, image: blobOf(image(f.image_file as string | null), sources), made_by: f.made_by, updated_at: f.updated_at });
  }
  for (const t of db.prepare('SELECT * FROM terms WHERE paper_id=?').all(paperId) as Record<string, unknown>[]) {
    rows.get('term')!.set(t.term_key as string, {
      id: t.id, term: t.term, ko: t.ko, definition: t.definition, in_paper: t.in_paper, page: t.page, made_by: t.made_by,
      created_at: t.created_at, source: t.source,
    });
  }
  const translations = db
    .prepare('SELECT t.block_idx, t.ko, t.sentences, t.made_by, b.text FROM translations t LEFT JOIN blocks b ON b.paper_id=t.paper_id AND b.idx=t.block_idx WHERE t.paper_id=?')
    .all(paperId) as { block_idx: number; ko: string; sentences: string | null; made_by: string | null; text: string | null }[];
  for (const t of translations) {
    // A translation only fits the block it was made for; other devices check this before applying it.
    rows.get('translation')!.set(String(t.block_idx), { ko: t.ko, sentences: t.sentences, made_by: t.made_by, block: t.text === null ? null : sha1(t.text) });
  }
  return rows;
}

/** Block text hashes of the paper, for checking that a remote translation fits. */
export function blockHashes(paperId: string): Map<string, string> {
  const rows = db.prepare('SELECT idx, text FROM blocks WHERE paper_id=?').all(paperId) as { idx: number; text: string }[];
  return new Map(rows.map((b) => [String(b.idx), sha1(b.text)]));
}

/** Where a downloaded blob can be found before it is moved into place. */
export type BlobFiles = Map<string, string>;

const str = (v: unknown) => (typeof v === 'string' ? v : null);
const num = (v: unknown) => (typeof v === 'number' ? v : null);

/** Place a blob as `images/<name>`, reusing the current file when it already holds the same bytes. */
function placeImage(sha: unknown, current: string | null, preferred: string, blobs: BlobFiles): string | null {
  if (typeof sha !== 'string') {
    if (current) rmSync(join(PATHS.images, current), { force: true });
    return null;
  }
  if (current && fileSha256(join(PATHS.images, current)) === sha) return current;
  const source = blobs.get(sha);
  if (!source) throw new Error(`동기화할 그림 파일을 받지 못했습니다 (${sha.slice(0, 8)})`);
  writeFileSync(join(PATHS.images, preferred), readFileSync(source));
  if (current && current !== preferred) rmSync(join(PATHS.images, current), { force: true });
  return preferred;
}

/** Insert or update the papers row; the DOI is left alone if another paper already has it. */
export function applyPaper(paperId: string, d: RowData): void {
  const exists = db.prepare('SELECT 1 FROM papers WHERE id=?').get(paperId) !== undefined;
  const values = [str(d.title) ?? '제목 없음', str(d.authors) ?? '[]', num(d.year), str(d.journal), str(d.volume), str(d.issue), str(d.pages)];
  const ids = [str(d.arxiv_id), str(d.openalex_id), str(d.pmid), str(d.pmcid), str(d.abstract), str(d.field), str(d.field_suggested)];
  const doi = str(d.doi);
  const doiTaken = doi !== null && db.prepare('SELECT 1 FROM papers WHERE doi=? AND id<>?').get(doi, paperId) !== undefined;
  if (exists) {
    db.prepare(`UPDATE papers SET title=?, authors=?, year=?, journal=?, volume=?, issue=?, pages=?, arxiv_id=?, openalex_id=?, pmid=?, pmcid=?,
      abstract=?, field=?, field_suggested=?, updated_at=?${doiTaken ? '' : ', doi=?'} WHERE id=?`)
      .run(...values, ...ids, now(), ...(doiTaken ? [] : [doi]), paperId);
  } else {
    db.prepare(`INSERT INTO papers(id,title,authors,year,journal,volume,issue,pages,arxiv_id,openalex_id,pmid,pmcid,abstract,field,field_suggested,doi,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(paperId, ...values, ...ids, doiTaken ? null : doi, str(d.created_at) ?? now(), now());
  }
}

/** Write a downloaded PDF into place as the paper's own file. */
export function placePdf(paperId: string, sha: string, blobs: BlobFiles): void {
  const source = blobs.get(sha);
  if (!source) throw new Error('동기화할 PDF를 받지 못했습니다');
  const target = join(PATHS.pdfs, `${paperId}.pdf`);
  const staging = `${target}.sync-${nanoid(6)}`;
  writeFileSync(staging, readFileSync(source));
  renameSync(staging, target);
}

/** Apply one non-paper row; returns false when it cannot be applied yet (it is retried on a later sync). */
export function applyRow(paperId: string, entity: Exclude<Entity, 'paper'>, key: string, d: RowData, blobs: BlobFiles, blocks: Map<string, string>): boolean {
  switch (entity) {
    case 'thread':
      db.prepare(`INSERT INTO threads(id,paper_id,title,model,kind,anchor,created_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, model=excluded.model, kind=excluded.kind, anchor=excluded.anchor`)
        .run(key, paperId, str(d.title) ?? '', str(d.model), str(d.kind) ?? 'chat', str(d.anchor), str(d.created_at) ?? now());
      return true;
    case 'message': {
      const thread = db.prepare('SELECT 1 FROM threads WHERE id=? AND paper_id=?').get(str(d.thread_id), paperId);
      if (!thread) return false;
      const current = imageFileOf('SELECT image_file FROM messages WHERE id=?', key);
      const file = placeImage(d.image, current, `${key}.png`, blobs);
      db.prepare(`INSERT INTO messages(id,thread_id,role,action,content,quote,page,image_file,engine,made_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET role=excluded.role, action=excluded.action, content=excluded.content, quote=excluded.quote, page=excluded.page,
          image_file=excluded.image_file, engine=excluded.engine, made_by=excluded.made_by`)
        .run(key, str(d.thread_id), str(d.role) ?? 'user', str(d.action), str(d.content) ?? '', str(d.quote), num(d.page), file, str(d.engine), str(d.made_by), str(d.created_at) ?? now());
      return true;
    }
    case 'highlight': {
      const current = imageFileOf('SELECT image_file FROM highlights WHERE id=?', key);
      const file = placeImage(d.image, current, `${key}.png`, blobs);
      db.prepare(`INSERT INTO highlights(id,paper_id,type,color,position,text,image_file,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET type=excluded.type, color=excluded.color, position=excluded.position, text=excluded.text,
          image_file=excluded.image_file, note=excluded.note, updated_at=excluded.updated_at`)
        .run(key, paperId, str(d.type) ?? 'text', str(d.color) ?? 'yellow', str(d.position) ?? '{}', str(d.text), file, str(d.note), str(d.created_at) ?? now(), str(d.updated_at) ?? now());
      return true;
    }
    case 'artifact':
      db.prepare(`INSERT INTO artifacts(paper_id,kind,content,meta,engine,made_by,updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(paper_id,kind) DO UPDATE SET content=excluded.content, meta=excluded.meta, engine=excluded.engine, made_by=excluded.made_by, updated_at=excluded.updated_at`)
        .run(paperId, key, str(d.content) ?? '', str(d.meta) ?? '{}', str(d.engine), str(d.made_by), str(d.updated_at) ?? now());
      return true;
    case 'figure': {
      const current = imageFileOf('SELECT image_file FROM figures WHERE paper_id=? AND anchor=?', paperId, key);
      const file = placeImage(d.image, current, `fig-${nanoid(12)}.png`, blobs);
      db.prepare(`INSERT INTO figures(paper_id,anchor,spec,image_file,made_by,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(paper_id,anchor) DO UPDATE SET spec=excluded.spec, image_file=excluded.image_file, made_by=excluded.made_by, updated_at=excluded.updated_at`)
        .run(paperId, key, str(d.spec) ?? '{}', file, str(d.made_by), str(d.updated_at) ?? now());
      return true;
    }
    case 'term': {
      const wanted = str(d.id) ?? nanoid(12);
      const idTaken = db.prepare('SELECT 1 FROM terms WHERE id=? AND NOT (paper_id=? AND term_key=?)').get(wanted, paperId, key) !== undefined;
      db.prepare(`INSERT INTO terms(id,paper_id,term,term_key,ko,definition,in_paper,page,made_by,created_at,source) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(paper_id,term_key) DO UPDATE SET term=excluded.term, ko=excluded.ko, definition=excluded.definition, in_paper=excluded.in_paper,
          page=excluded.page, made_by=excluded.made_by, source=excluded.source`)
        .run(idTaken ? nanoid(12) : wanted, paperId, str(d.term) ?? key, key, str(d.ko) ?? '', str(d.definition) ?? '', str(d.in_paper) ?? '', num(d.page),
          str(d.made_by), str(d.created_at) ?? now(), str(d.source) ?? 'lookup');
      return true;
    }
    case 'translation':
      // Different app versions can split the PDF differently; wait until this device has the same block.
      if (!d.block || blocks.get(key) !== d.block) return false;
      db.prepare(`INSERT INTO translations(paper_id,block_idx,ko,sentences,made_by) VALUES(?,?,?,?,?)
        ON CONFLICT(paper_id,block_idx) DO UPDATE SET ko=excluded.ko, sentences=excluded.sentences, made_by=excluded.made_by`)
        .run(paperId, Number(key), str(d.ko) ?? '', str(d.sentences), str(d.made_by));
      return true;
  }
}

/** Remove one row (and its image) that another device deleted. */
export function deleteRow(paperId: string, entity: Exclude<Entity, 'paper'>, key: string): void {
  switch (entity) {
    case 'thread': {
      const images = db.prepare('SELECT image_file FROM messages WHERE thread_id=? AND image_file IS NOT NULL').all(key).map((r) => r.image_file);
      db.prepare('DELETE FROM threads WHERE id=? AND paper_id=?').run(key, paperId);
      for (const file of images) removeImageFile(typeof file === 'string' ? file : null);
      return;
    }
    case 'message':
      removeImageFile(imageFileOf('SELECT image_file FROM messages WHERE id=?', key));
      db.prepare('DELETE FROM messages WHERE id=? AND thread_id IN (SELECT id FROM threads WHERE paper_id=?)').run(key, paperId);
      return;
    case 'highlight':
      removeImageFile(imageFileOf('SELECT image_file FROM highlights WHERE id=? AND paper_id=?', key, paperId));
      db.prepare('DELETE FROM highlights WHERE id=? AND paper_id=?').run(key, paperId);
      return;
    case 'artifact':
      db.prepare('DELETE FROM artifacts WHERE paper_id=? AND kind=?').run(paperId, key);
      return;
    case 'figure':
      removeImageFile(imageFileOf('SELECT image_file FROM figures WHERE paper_id=? AND anchor=?', paperId, key));
      db.prepare('DELETE FROM figures WHERE paper_id=? AND anchor=?').run(paperId, key);
      return;
    case 'term':
      db.prepare('DELETE FROM terms WHERE paper_id=? AND term_key=?').run(paperId, key);
      return;
    case 'translation':
      db.prepare('DELETE FROM translations WHERE paper_id=? AND block_idx=?').run(paperId, Number(key));
      return;
  }
}

/** True when a file exists at the local path a paper's PDF would occupy. */
export const hasPdfFile = (pdfFile: string | null) => !!pdfFile && existsSync(join(PATHS.pdfs, pdfFile));
