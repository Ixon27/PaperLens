import { DatabaseSync } from 'node:sqlite';
import { PATHS } from './config';

export const db = new DatabaseSync(PATHS.db);

db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS papers(id TEXT PRIMARY KEY, title TEXT NOT NULL, authors TEXT NOT NULL DEFAULT '[]',
  year INTEGER, journal TEXT, volume TEXT, issue TEXT, pages TEXT, doi TEXT UNIQUE, arxiv_id TEXT,
  openalex_id TEXT, pmid TEXT, pmcid TEXT, abstract TEXT, pdf_file TEXT, page_count INTEGER,
  research_types TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_opened_at TEXT);
CREATE TABLE IF NOT EXISTS blocks(paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
  page INTEGER NOT NULL, text TEXT NOT NULL, lines TEXT NOT NULL,
  page_w REAL NOT NULL, page_h REAL NOT NULL, is_ref INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(paper_id, idx));
CREATE TABLE IF NOT EXISTS translations(paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE, block_idx INTEGER NOT NULL,
  ko TEXT NOT NULL, PRIMARY KEY(paper_id, block_idx));
CREATE TABLE IF NOT EXISTS artifacts(paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  content TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', engine TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(paper_id, kind));
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, paper_id TEXT REFERENCES papers(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0, message TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS highlights(id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE, type TEXT NOT NULL,
  color TEXT NOT NULL, position TEXT NOT NULL, text TEXT, image_file TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE, title TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, role TEXT NOT NULL,
  action TEXT, content TEXT NOT NULL, quote TEXT, page INTEGER, image_file TEXT, engine TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(paper_id UNINDEXED, title, authors, body);
CREATE INDEX IF NOT EXISTS jobs_paper ON jobs(paper_id, kind, created_at);
CREATE INDEX IF NOT EXISTS highlights_paper ON highlights(paper_id);
CREATE INDEX IF NOT EXISTS threads_paper ON threads(paper_id);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, created_at);
`);

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
export function isTranslatable(b: Pick<BlockRow, 'is_ref' | 'text'>): boolean {
  return !b.is_ref && /[A-Za-z]{3,}/.test(b.text);
}

export interface ArtifactRow {
  paper_id: string;
  kind: string;
  content: string;
  meta: string;
  engine: string | null;
  updated_at: string;
}

export function getArtifact(paperId: string, kind: string): ArtifactRow | undefined {
  return db.prepare('SELECT * FROM artifacts WHERE paper_id=? AND kind=?').get(paperId, kind) as ArtifactRow | undefined;
}

export function putArtifact(paperId: string, kind: string, content: string, meta: object, engine: string | null) {
  db.prepare(
    `INSERT INTO artifacts(paper_id,kind,content,meta,engine,updated_at) VALUES(?,?,?,?,?,?)
     ON CONFLICT(paper_id,kind) DO UPDATE SET content=excluded.content, meta=excluded.meta, engine=excluded.engine, updated_at=excluded.updated_at`,
  ).run(paperId, kind, content, JSON.stringify(meta), engine, now());
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
