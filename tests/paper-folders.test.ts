import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { Hono } from 'hono';
import type * as OpenAlex from '../src/server/services/openalex';
import type { WorkMeta } from '../src/server/services/crossref';

vi.mock('../src/server/config', async () => {
  // Vitest hoists this factory before static imports; filesystem setup must load inside it.
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'paper-folders-'));
  const pdfs = join(root, 'pdfs');
  const tmp = join(root, 'tmp');
  mkdirSync(pdfs);
  mkdirSync(tmp);
  return { PATHS: { db: ':memory:', pdfs, tmp, images: join(root, 'images'), prompts: '/unused/prompts' }, BIN: { claude: null, codex: null }, EMAIL: null };
});
vi.mock('../src/server/jobs', () => ({ activeJob: vi.fn(() => null), startJob: vi.fn(() => 'job'), latestJobs: () => [], snapshotOf: vi.fn() }));
vi.mock('../src/server/pdf/extract', () => ({ extractBlocks: vi.fn() }));
vi.mock('../src/server/services/crossref', () => ({ getWork: vi.fn() }));
vi.mock('../src/server/services/openalex', async (original) => ({
  ...await original<typeof OpenAlex>(), getByDoi: vi.fn(), getById: vi.fn(),
}));

import { PATHS } from '../src/server/config';
import { db, getPaper, migratePaperFolders } from '../src/server/db';
import { HttpError } from '../src/server/http-error';
import { startJob, type JobCtx } from '../src/server/jobs';
import { extractBlocks } from '../src/server/pdf/extract';
import { folders } from '../src/server/routes/folders';
import { papers } from '../src/server/routes/papers';
import { getWork } from '../src/server/services/crossref';
import { getByDoi, getById } from '../src/server/services/openalex';
import { importFromInput, importUpload } from '../src/server/tasks/import';

const app = new Hono();
app.onError((error, c) => c.json({ error: error.message }, error instanceof HttpError ? error.status : 500));
app.route('/api', folders);
app.route('/api', papers);
const request = (path: string, method: string, body: unknown) => app.request(`/api${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const create = async (name: string) => {
  const response = await request('/folders', 'POST', { name });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ id: string; name: string; createdAt: string; updatedAt: string }>;
};
const move = (paperIds: string[], folderId: string | null) => request('/papers/folder', 'PUT', { paperIds, folderId });
const extraction = { pageCount: 1, title: 'Uploaded title', blocks: [] };
const ctx: JobCtx = { jobId: 'job', signal: new AbortController().signal, progress: vi.fn(), message: vi.fn(), delta: vi.fn(), setText: vi.fn(), emit: vi.fn() };
const metadata: WorkMeta = { title: 'New metadata paper', authors: [], year: null, journal: null, volume: null, issue: null, pages: null, abstract: null };

beforeEach(() => {
  db.exec('DROP TRIGGER IF EXISTS fail_folder_move; DELETE FROM papers; DELETE FROM folders; DELETE FROM papers_fts');
  vi.clearAllMocks();
  vi.mocked(extractBlocks).mockReset().mockResolvedValue(extraction);
  vi.mocked(getWork).mockReset().mockResolvedValue(null);
  vi.mocked(getByDoi).mockReset().mockResolvedValue(null);
  vi.mocked(getById).mockReset().mockResolvedValue(null);
  const insert = db.prepare('INSERT INTO papers(id,title,doi,created_at,updated_at) VALUES(?,?,?,?,?)');
  insert.run('a', 'Existing paper', '10.1234/existing', '2020-01-01', '2020-01-01');
  insert.run('b', 'Other paper', null, '2020-01-01', '2020-01-01');
});
afterAll(() => rmSync(dirname(PATHS.tmp), { recursive: true, force: true }));

describe('persistent flat folder routes', () => {
  it('trims names, lists full DTOs, preserves folder identity on rename and rejects case-insensitive duplicates', async () => {
    const folder = await create('  Älpha 연구  ');
    expect(folder).toEqual({ id: expect.any(String), name: 'Älpha 연구', createdAt: expect.any(String), updatedAt: expect.any(String) });
    expect((await request('/folders', 'POST', { name: 'älPHA 연구' })).status).toBe(400);
    const other = await create('Other');
    expect((await request(`/folders/${other.id}`, 'PUT', { name: ' ÄLPHA 연구 ' })).status).toBe(400);
    const renamed = await request(`/folders/${folder.id}`, 'PUT', { name: ' Renamed ' });
    expect(await renamed.json()).toMatchObject({ id: folder.id, name: 'Renamed', createdAt: folder.createdAt });
    expect(await (await app.request('/api/folders')).json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: folder.id, name: 'Renamed' })]));
    expect(db.prepare('SELECT name_key FROM folders WHERE id=?').get(folder.id)?.name_key).toBe('renamed');
  });

  it.each([{}, { name: '' }, { name: ' \n ' }, { name: 'x'.repeat(81) }, { name: null }, { name: 1 }, [], null])('rejects invalid names: %j', async (body) => {
    const folder = await create('Original');
    expect((await request('/folders', 'POST', body)).status).toBe(400);
    expect((await request(`/folders/${folder.id}`, 'PUT', body)).status).toBe(400);
    expect(db.prepare('SELECT name FROM folders WHERE id=?').get(folder.id)?.name).toBe('Original');
  });

  it('accepts 80 Unicode characters and returns Korean errors for malformed requests and missing folders', async () => {
    await create('😀'.repeat(80));
    expect((await app.request('/api/folders', { method: 'POST', body: '{' })).status).toBe(400);
    for (const method of ['PUT', 'DELETE']) {
      const response = await request('/folders/missing', method, { name: 'Valid' });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: '폴더를 찾을 수 없습니다' });
    }
  });

  it('moves and clears batches without changing independent paper metadata', async () => {
    const folder = await create('Project');
    const other = await create('Other');
    db.prepare("UPDATE papers SET starred=1, read_status='reading', field='physics' WHERE id='a'").run();
    expect((await move(['a', 'b'], folder.id)).status).toBe(200);
    expect(getPaper('a')).toMatchObject({ folder_id: folder.id, starred: 1, read_status: 'reading', field: 'physics' });
    expect(getPaper('a')?.updated_at).not.toBe('2020-01-01');
    await move(['a'], other.id);
    expect(getPaper('a')?.folder_id).toBe(other.id);
    expect(getPaper('b')?.folder_id).toBe(folder.id);
    const cleared = await move(['a', 'b'], null);
    expect(await cleared.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'a', folderId: null })]));
    expect(getPaper('a')?.folder_id).toBeNull();
    expect(await (await app.request('/api/papers/a')).json()).toMatchObject({ folderId: null });
    expect(await (await app.request('/api/papers')).json()).toEqual(expect.arrayContaining([expect.objectContaining({ folderId: null })]));
  });

  it('validates the entire batch before moving and rolls back database failures', async () => {
    const folder = await create('Project');
    expect((await move(['a', 'missing'], folder.id)).status).toBe(404);
    expect((await move(['a'], 'missing')).status).toBe(404);
    expect(getPaper('a')).toMatchObject({ folder_id: null, updated_at: '2020-01-01' });
    db.exec("CREATE TRIGGER fail_folder_move BEFORE UPDATE OF folder_id ON papers WHEN NEW.id='b' BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    expect((await move(['a', 'b'], folder.id)).status).toBe(500);
    expect(getPaper('a')).toMatchObject({ folder_id: null, updated_at: '2020-01-01' });
  });

  it.each([{}, { paperIds: [] }, { paperIds: ['a'] }, { paperIds: ['a'], folderId: '' }, { paperIds: ['a'], folderId: 1 },
    { paperIds: ['a', 'a'], folderId: null }, { paperIds: [1], folderId: null }, { paperIds: [' '], folderId: null }, [], null])('rejects invalid batch requests: %j', async (body) => {
    expect((await request('/papers/folder', 'PUT', body)).status).toBe(400);
    expect(getPaper('a')?.folder_id).toBeNull();
  });

  it('deletes only the folder and unfiles its papers, preserving PDFs and saved work', async () => {
    const folder = await create('Project');
    await move(['a'], folder.id);
    db.prepare("UPDATE papers SET pdf_file='a.pdf' WHERE id='a'").run();
    db.prepare("INSERT INTO artifacts(paper_id,kind,content,updated_at) VALUES('a','summary','Saved work','2020')").run();
    expect((await app.request(`/api/folders/${folder.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(getPaper('a')).toMatchObject({ folder_id: null, pdf_file: 'a.pdf', title: 'Existing paper' });
    expect(db.prepare("SELECT content FROM artifacts WHERE paper_id='a'").get()?.content).toBe('Saved work');
    expect(await (await app.request('/api/folders')).json()).toEqual([]);
  });
});

describe('folder import contract', () => {
  it('preserves duplicate assignments when omitted and applies explicit destination or null', async () => {
    const folder = await create('Project');
    await move(['a'], folder.id);
    expect(await importFromInput('10.1234/existing', null)).toMatchObject({ paperId: 'a', duplicate: true });
    expect(getPaper('a')?.folder_id).toBe(folder.id);
    expect((await request('/papers/import', 'POST', { input: '10.1234/existing', folderId: null })).status).toBe(200);
    expect(getPaper('a')?.folder_id).toBeNull();
    await importFromInput('10.1234/existing', null, folder.id);
    expect(getPaper('a')?.folder_id).toBe(folder.id);
    const response = await request('/papers/import', 'POST', { input: '10.1234/existing', folderId: 'missing' });
    expect(response.status).toBe(404);
    expect(getPaper('a')?.folder_id).toBe(folder.id);
  });

  it('assigns metadata imports and safely unfiles when their destination is deleted during lookup', async () => {
    const folder = await create('Project');
    vi.mocked(getWork).mockResolvedValue(metadata);
    const first = await importFromInput('10.1234/new', null, folder.id);
    expect(getPaper(first.paperId)?.folder_id).toBe(folder.id);
    const lookup = Promise.withResolvers<WorkMeta>();
    vi.mocked(getWork).mockReturnValueOnce(lookup.promise);
    const pending = importFromInput('10.1234/race', null, folder.id);
    await app.request(`/api/folders/${folder.id}`, { method: 'DELETE' });
    lookup.resolve({ ...metadata, title: 'Race paper' });
    const result = await pending;
    expect(getPaper(result.paperId)?.folder_id).toBeNull();
  });

  it('supports multipart assignment and explicit duplicate clearing', async () => {
    const folder = await create('Project');
    vi.mocked(extractBlocks).mockResolvedValue({ ...extraction, blocks: [{ idx: 0, page: 1, text: 'doi:10.1234/existing', lines: [], pageW: 100, pageH: 100, isRef: false, kind: 'body', spans: [] }] });
    const upload = async (folderId?: string) => {
      const form = new FormData();
      form.append('file', new File(['%PDF mocked'], 'paper.pdf', { type: 'application/pdf' }));
      if (folderId !== undefined) form.append('folderId', folderId);
      return app.request('/api/papers/upload', { method: 'POST', body: form });
    };
    expect((await upload(folder.id)).status).toBe(200);
    expect(getPaper('a')?.folder_id).toBe(folder.id);
    await upload();
    expect(getPaper('a')?.folder_id).toBe(folder.id);
    await upload('');
    expect(getPaper('a')?.folder_id).toBeNull();
    expect((await upload('missing')).status).toBe(404);
  });

  it('does not restore stale assignments when PDF enrichment finishes after moving or deleting a folder', async () => {
    const folder = await create('Project');
    const other = await create('Other');
    const result = await importUpload('paper.pdf', Buffer.from('%PDF mocked'), null, folder.id);
    expect(getPaper(result.paperId)?.folder_id).toBe(folder.id);
    const runner = vi.mocked(startJob).mock.calls.at(-1)![2];
    await move([result.paperId], other.id);
    await app.request(`/api/folders/${folder.id}`, { method: 'DELETE' });
    await runner(ctx);
    expect(getPaper(result.paperId)).toMatchObject({ folder_id: other.id, pdf_file: `${result.paperId}.pdf` });
    const second = await importUpload('second.pdf', Buffer.from('%PDF mocked'), null, other.id);
    const secondRunner = vi.mocked(startJob).mock.calls.at(-1)![2];
    await app.request(`/api/folders/${other.id}`, { method: 'DELETE' });
    await secondRunner(ctx);
    expect(getPaper(second.paperId)).toMatchObject({ folder_id: null, pdf_file: `${second.paperId}.pdf` });
  });

  it('handles folder deletion during asynchronous PDF extraction without a dangling reference', async () => {
    const folder = await create('Project');
    const extracting = Promise.withResolvers<typeof extraction>();
    vi.mocked(extractBlocks).mockReturnValueOnce(extracting.promise);
    const pending = importUpload('race.pdf', Buffer.from('%PDF mocked'), null, folder.id);
    await app.request(`/api/folders/${folder.id}`, { method: 'DELETE' });
    extracting.resolve(extraction);
    const result = await pending;
    expect(getPaper(result.paperId)?.folder_id).toBeNull();
  });
});

it('migrates legacy databases in place, idempotently, with indexed nullable foreign keys', () => {
  const legacy = new DatabaseSync(':memory:');
  try {
    legacy.exec("PRAGMA foreign_keys=ON; CREATE TABLE papers(id TEXT PRIMARY KEY,title TEXT,created_at TEXT,updated_at TEXT); INSERT INTO papers VALUES('legacy','Original','old','old')");
    migratePaperFolders(legacy);
    expect(legacy.prepare('SELECT * FROM papers').get()).toMatchObject({ id: 'legacy', title: 'Original', created_at: 'old', updated_at: 'old', folder_id: null });
    legacy.exec("INSERT INTO folders VALUES('f','Project','project','old','old'); UPDATE papers SET folder_id='f'");
    migratePaperFolders(legacy);
    expect(legacy.prepare('SELECT folder_id FROM papers').get()?.folder_id).toBe('f');
    expect(legacy.prepare('PRAGMA index_list(papers)').all().map((row) => row.name)).toContain('papers_folder');
    expect(() => legacy.exec("UPDATE papers SET folder_id='missing'")).toThrow();
    legacy.exec("DELETE FROM folders WHERE id='f'");
    expect(legacy.prepare('SELECT * FROM papers').get()).toMatchObject({ id: 'legacy', title: 'Original', folder_id: null });
  } finally {
    legacy.close();
  }
});
