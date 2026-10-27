import { DatabaseSync } from 'node:sqlite';
import { PATHS } from './config';
import type { EngineId, MadeBy } from '../shared/models';

export const db = new DatabaseSync(PATHS.db);

db.exec(`
PRAGMA busy_timeout=5000;
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS papers(id TEXT PRIMARY KEY, title TEXT NOT NULL, authors TEXT NOT NULL DEFAULT '[]',
  year INTEGER, journal TEXT, volume TEXT, issue TEXT, pages TEXT, doi TEXT UNIQUE, arxiv_id TEXT,
  openalex_id TEXT, pmid TEXT, pmcid TEXT, abstract TEXT, pdf_file TEXT, page_count INTEGER,
  research_types TEXT, layout_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_opened_at TEXT);
CREATE TABLE IF NOT EXISTS blocks(paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
  page INTEGER NOT NULL, text TEXT NOT NULL, lines TEXT NOT NULL,
  page_w REAL NOT NULL, page_h REAL NOT NULL, is_ref INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'body',
  spans TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(paper_id, idx));
CREATE TABLE IF NOT EXISTS translations(paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE, block_idx INTEGER NOT NULL,
  ko TEXT NOT NULL, sentences TEXT, made_by TEXT, PRIMARY KEY(paper_id, block_idx));
CREATE TABLE IF NOT EXISTS artifacts(paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  content TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', engine TEXT, made_by TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(paper_id, kind));
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, paper_id TEXT REFERENCES papers(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0, message TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS highlights(id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE, type TEXT NOT NULL,
  color TEXT NOT NULL, position TEXT NOT NULL, text TEXT, image_file TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE, title TEXT NOT NULL,
  model TEXT, kind TEXT NOT NULL DEFAULT 'chat', anchor TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, role TEXT NOT NULL,
  action TEXT, content TEXT NOT NULL, quote TEXT, page INTEGER, image_file TEXT, engine TEXT, made_by TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS terms(id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE, term TEXT NOT NULL,
  term_key TEXT NOT NULL, ko TEXT NOT NULL, definition TEXT NOT NULL, in_paper TEXT NOT NULL, page INTEGER, made_by TEXT,
  created_at TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'lookup', UNIQUE(paper_id, term_key));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(paper_id UNINDEXED, title, authors, body);
CREATE INDEX IF NOT EXISTS jobs_paper ON jobs(paper_id, kind, created_at);
CREATE INDEX IF NOT EXISTS highlights_paper ON highlights(paper_id);
CREATE INDEX IF NOT EXISTS threads_paper ON threads(paper_id);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, created_at);
`);

// Columns added after the first release: existing databases gain them in place.
const columnsOf = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
if (!columnsOf('papers').has('layout_version')) db.exec('ALTER TABLE papers ADD COLUMN layout_version INTEGER NOT NULL DEFAULT 0');
if (!columnsOf('blocks').has('kind')) db.exec("ALTER TABLE blocks ADD COLUMN kind TEXT NOT NULL DEFAULT 'body'");
if (!columnsOf('blocks').has('spans')) db.exec("ALTER TABLE blocks ADD COLUMN spans TEXT NOT NULL DEFAULT '[]'");
if (!columnsOf('artifacts').has('made_by')) db.exec('ALTER TABLE artifacts ADD COLUMN made_by TEXT');
if (!columnsOf('messages').has('made_by')) db.exec('ALTER TABLE messages ADD COLUMN made_by TEXT');
if (!columnsOf('threads').has('model')) db.exec('ALTER TABLE threads ADD COLUMN model TEXT');
if (!columnsOf('threads').has('kind')) db.exec("ALTER TABLE threads ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'");
if (!columnsOf('threads').has('anchor')) db.exec('ALTER TABLE threads ADD COLUMN anchor TEXT');
if (!columnsOf('terms').has('source')) db.exec("ALTER TABLE terms ADD COLUMN source TEXT NOT NULL DEFAULT 'lookup'");
{
  const tr = columnsOf('translations');
  if (!tr.has('sentences')) db.exec('ALTER TABLE translations ADD COLUMN sentences TEXT');
  if (!tr.has('made_by')) db.exec('ALTER TABLE translations ADD COLUMN made_by TEXT');
}

db.prepare(`UPDATE jobs SET status='error', error='서버 재시작으로 중단', updated_at=? WHERE status IN ('queued','running')`).run(
  new Date().toISOString(),
);

export const now = () => new Date().toISOString();

/** Run fn inside BEGIN/COMMIT, rolling back on throw. */
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export interface PaperRow {
  id: string;
  title: string;
  authors: string;
  year: number | null;
  journal: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  doi: string | null;
  arxiv_id: string | null;
  openalex_id: string | null;
  pmid: string | null;
  pmcid: string | null;
  abstract: string | null;
  pdf_file: string | null;
  page_count: number | null;
  research_types: string | null;
  /** Block layout the paper's blocks were made with; see LAYOUT_VERSION. */
  layout_version: number;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
}

export interface BlockRow {
  paper_id: string;
  idx: number;
  page: number;
  text: string;
  lines: string;
  page_w: number;
  page_h: number;
  is_ref: number;
  /** body | heading | caption | aside — only `aside` is left out of the reading text. */
  kind: string;
  /** JSON TextSpan[]: where the block's characters sit in the viewer's text layer. */
  spans: string;
}

export interface Author {
  family: string;
  given?: string;
}

export function getPaper(id: string): PaperRow | undefined {
  return db.prepare('SELECT * FROM papers WHERE id=?').get(id) as PaperRow | undefined;
}

export function getBlocks(paperId: string): BlockRow[] {
  return db.prepare('SELECT * FROM blocks WHERE paper_id=? ORDER BY idx').all(paperId) as unknown as BlockRow[];
}

export function parseAuthors(row: Pick<PaperRow, 'authors'>): Author[] {
  try {
    return JSON.parse(row.authors) as Author[];
  } catch {
    return [];
  }
}

/** One definition of "translatable", shared by the translation task and status counts. */
export function isTranslatable(b: Pick<BlockRow, 'is_ref' | 'text' | 'kind'>): boolean {
  return !b.is_ref && b.kind !== 'aside' && /[A-Za-z]{3,}/.test(b.text);
}

export interface ArtifactRow {
  paper_id: string;
  kind: string;
  content: string;
  meta: string;
  engine: string | null;
  /** JSON MadeBy; null on rows made before model tracking (then only `engine` is known). */
  made_by: string | null;
  updated_at: string;
}

export function getArtifact(paperId: string, kind: string): ArtifactRow | undefined {
  return db.prepare('SELECT * FROM artifacts WHERE paper_id=? AND kind=?').get(paperId, kind) as ArtifactRow | undefined;
}

export function putArtifact(paperId: string, kind: string, content: string, meta: object, by: MadeBy | null) {
  db.prepare(
    `INSERT INTO artifacts(paper_id,kind,content,meta,engine,made_by,updated_at) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(paper_id,kind) DO UPDATE SET content=excluded.content, meta=excluded.meta, engine=excluded.engine,
       made_by=excluded.made_by, updated_at=excluded.updated_at`,
  ).run(paperId, kind, content, JSON.stringify(meta), by?.engine ?? null, by ? JSON.stringify(by) : null, now());
}

const isEngine = (v: unknown): v is EngineId => v === 'claude' || v === 'codex';

/** Who made a stored row: the recorded model, or just the engine on rows from before model tracking. */
export function madeByOf(row: { made_by: string | null; engine: string | null }): MadeBy | null {
  if (row.made_by) {
    const parsed = JSON.parse(row.made_by) as MadeBy;
    if (isEngine(parsed?.engine)) return parsed;
  }
  return isEngine(row.engine) ? { engine: row.engine } : null;
}

/** Rewrite the FTS row for a paper (title/authors from papers, body from blocks). */
export function refreshFts(paperId: string) {
  const p = getPaper(paperId);
  db.prepare('DELETE FROM papers_fts WHERE paper_id=?').run(paperId);
  if (!p) return;
  const authors = parseAuthors(p)
    .map((a) => [a.given, a.family].filter(Boolean).join(' '))
    .join(', ');
  const body = (db.prepare('SELECT text FROM blocks WHERE paper_id=? ORDER BY idx').all(paperId) as { text: string }[])
    .map((r) => r.text)
    .join('\n');
  db.prepare('INSERT INTO papers_fts(paper_id,title,authors,body) VALUES(?,?,?,?)').run(paperId, p.title, authors, body);
}
