import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Config from '../src/server/config';
import type { ExtractionResult } from '../src/server/pdf/extract';

vi.mock('../src/server/config', async (importOriginal) => {
  const original = await importOriginal<typeof Config>();
  // Vitest hoists this factory ahead of ordinary static imports.
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'paperlens-sync-test-'));
  const dirs = { pdfs: join(root, 'pdfs'), images: join(root, 'images'), tmp: join(root, 'tmp') };
  for (const d of Object.values(dirs)) mkdirSync(d);
  return { ...original, PATHS: { ...original.PATHS, db: ':memory:', files: root, ...dirs } };
});
vi.mock('../src/server/pdf/extract', () => ({ extractBlocks: vi.fn() }));

import { PATHS } from '../src/server/config';
import { db, getPaper } from '../src/server/db';
import { extractBlocks } from '../src/server/pdf/extract';
import { FORMAT, syncOnce, type Bundle, type BundleRow } from '../src/server/sync/engine';
import { deviceId } from '../src/server/sync/state';
import { MemoryTransport } from './fixtures/memory-transport';

const OTHER = 'aaaaaaaaaaaaaaaa';
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
/** A version from the other device at `ms` (Date.now()-based versions sort by time). */
const v = (ms: number) => `${ms.toString(36).padStart(10, '0')}.0000.${OTHER}`;
const later = () => v(Date.now() + 60_000);

const PDF = Buffer.from('%PDF-1.4 remote paper');
const IMAGE = Buffer.from('png bytes of a highlight');
const BLOCK = 'The remote block text.';

function extraction(text = BLOCK): ExtractionResult {
  return { title: null, pageCount: 1, blocks: [{ idx: 0, page: 1, text, lines: [], pageW: 600, pageH: 800, kind: 'body', isRef: false, spans: [] }] };
}

function bundleOf(paper: string, rows: BundleRow[]): Buffer {
  return Buffer.from(JSON.stringify({ format: FORMAT, device: OTHER, paper, rows } satisfies Bundle));
}

const paperData = (title: string, pdf: string | null) => ({
  title, authors: '[]', year: 2024, journal: null, volume: null, issue: null, pages: null, doi: null, arxiv_id: null, openalex_id: null,
  pmid: null, pmcid: null, abstract: null, field: 'physics', field_suggested: null, created_at: '2025-01-01T00:00:00.000Z', pdf,
});

const state = (paperId: string, entity: string, key: string) =>
  db.prepare('SELECT version, deleted FROM sync_rows WHERE paper_id=? AND entity=? AND key=?').get(paperId, entity, key) as { version: string; deleted: number } | undefined;

function addLocalPaper(id: string) {
  writeFileSync(join(PATHS.pdfs, `${id}.pdf`), Buffer.from(`%PDF local ${id}`));
  db.prepare('INSERT INTO papers(id,title,pdf_file,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, `Local ${id}`, `${id}.pdf`, '2025-01-01', '2025-01-01');
  db.prepare("INSERT INTO blocks(paper_id,idx,page,text,lines,page_w,page_h) VALUES(?,0,1,'Local block text.','[]',600,800)").run(id);
  db.prepare("INSERT INTO translations(paper_id,block_idx,ko) VALUES(?,0,'로컬 번역')").run(id);
  writeFileSync(join(PATHS.images, 'h1.png'), IMAGE);
  db.prepare("INSERT INTO highlights(id,paper_id,type,color,position,text,image_file,note,created_at,updated_at) VALUES('h1',?,'area','yellow','{}',null,'h1.png','첫 메모','2025-01-01','2025-01-01')").run(id);
  db.prepare("INSERT INTO artifacts(paper_id,kind,content,updated_at) VALUES(?,'summary','요약','2025-01-01'),(?,'related','{}','2025-01-01')").run(id, id);
}

let transport: MemoryTransport;

afterAll(() => rmSync(PATHS.files, { recursive: true, force: true }));

beforeEach(() => {
  db.exec('DELETE FROM papers; DELETE FROM folders; DELETE FROM sync_rows; DELETE FROM sync_files; DELETE FROM sync_published; DELETE FROM sync_alias; DELETE FROM sync_conflicts; DELETE FROM sync_meta');
  transport = new MemoryTransport();
  vi.mocked(extractBlocks).mockReset().mockResolvedValue(extraction());
});

describe('publishing', () => {
  it('uploads every syncable row with the PDF and images it points at, once', async () => {
    addLocalPaper('p1');
    const first = await syncOnce(transport);
    expect(first.published).toBe(1);

    const bundle = JSON.parse(transport.get(`pl1/dev/${deviceId()}/paper/p1.json`)!.toString()) as Bundle;
    const rows = new Map(bundle.rows.map((r) => [`${r[0]}:${r[1]}`, r]));
    expect([...rows.keys()].sort()).toEqual(['artifact:summary', 'folder_assignment:_', 'highlight:h1', 'paper:_', 'translation:0']);
    expect(rows.get('translation:0')![5]).toMatchObject({ ko: '로컬 번역', block: sha1('Local block text.') });
    const pdfSha = rows.get('paper:_')![5]!.pdf as string;
    expect(transport.get(`pl1/blob/${pdfSha}`)?.toString()).toBe('%PDF local p1');
    expect(transport.get(`pl1/blob/${sha256(IMAGE)}`)).toEqual(IMAGE);

    expect((await syncOnce(transport)).published).toBe(0);
  });

  it('publishes a deletion as tombstones', async () => {
    addLocalPaper('p1');
    await syncOnce(transport);
    db.prepare('DELETE FROM papers WHERE id=?').run('p1');
    await syncOnce(transport);
    const bundle = JSON.parse(transport.get(`pl1/dev/${deviceId()}/paper/p1.json`)!.toString()) as Bundle;
    expect(bundle.rows.every((r) => r[4] === 1 && r[5] === null)).toBe(true);
  });
});

describe('merging another device', () => {
  it('brings in a new paper with its PDF, extracted blocks, translation and image', async () => {
    const pdfSha = sha256(PDF);
    transport.put(`pl1/blob/${pdfSha}`, PDF);
    transport.put(`pl1/blob/${sha256(IMAGE)}`, IMAGE);
    transport.put(`pl1/dev/${OTHER}/paper/r1.json`, bundleOf('r1', [
      ['paper', '_', v(1000), null, 0, paperData('Remote paper', pdfSha)],
      ['translation', '0', v(1001), null, 0, { ko: '원격 번역', sentences: null, made_by: null, block: sha1(BLOCK) }],
      ['highlight', 'h9', v(1002), null, 0, { type: 'area', color: 'blue', position: '{}', text: null, image: sha256(IMAGE), note: '원격 메모', created_at: 'x', updated_at: 'x' }],
    ]));

    const result = await syncOnce(transport);

    expect(result.applied).toBe(3);
    expect(getPaper('r1')).toMatchObject({ title: 'Remote paper', field: 'physics', pdf_file: 'r1.pdf' });
    expect(readFileSync(join(PATHS.pdfs, 'r1.pdf'))).toEqual(PDF);
    expect(db.prepare('SELECT ko FROM translations WHERE paper_id=?').get('r1')).toEqual({ ko: '원격 번역' });
    expect(readFileSync(join(PATHS.images, 'h9.png'))).toEqual(IMAGE);
    // Applied rows keep the other device's versions, so nothing bounces back as a new edit.
    expect(state('r1', 'highlight', 'h9')?.version).toBe(v(1002));
  });

  it('deletes a paper removed elsewhere, unless it was edited here after that deletion', async () => {
    addLocalPaper('p1');
    await syncOnce(transport);
    transport.put(`pl1/dev/${OTHER}/paper/p1.json`, bundleOf('p1', [['paper', '_', v(1), null, 1, null]]));
    await syncOnce(transport);
    expect(getPaper('p1')).toBeDefined();

    transport.put(`pl1/dev/${OTHER}/paper/p1.json`, bundleOf('p1', [['paper', '_', later(), null, 1, null]]));
    await syncOnce(transport);
    expect(getPaper('p1')).toBeUndefined();
    expect(existsSync(join(PATHS.pdfs, 'p1.pdf'))).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_conflicts').get()).toEqual({ n: 1 });
  });

  it('keeps an overwritten local edit the other device never saw', async () => {
    addLocalPaper('p1');
    await syncOnce(transport);
    const seen = state('p1', 'highlight', 'h1')!.version;
    const remote = (note: string, version: string, base: string | null): BundleRow =>
      ['highlight', 'h1', version, base, 0, { type: 'area', color: 'yellow', position: '{}', text: null, image: sha256(IMAGE), note, created_at: '2025-01-01', updated_at: 'y' }];

    // An edit made on top of what this device published: no conflict.
    transport.put(`pl1/dev/${OTHER}/paper/p1.json`, bundleOf('p1', [remote('이어서 고친 메모', later(), seen)]));
    await syncOnce(transport);
    expect(db.prepare('SELECT note FROM highlights WHERE id=?').get('h1')).toEqual({ note: '이어서 고친 메모' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_conflicts').get()).toEqual({ n: 0 });

    // A concurrent edit on both devices: the newer one wins, the local one is kept.
    db.prepare("UPDATE highlights SET note='여기서 고친 메모' WHERE id='h1'").run();
    await syncOnce(transport);
    transport.put(`pl1/dev/${OTHER}/paper/p1.json`, bundleOf('p1', [remote('저기서 고친 메모', v(Date.now() + 120_000), seen)]));
    await syncOnce(transport);
    expect(db.prepare('SELECT note FROM highlights WHERE id=?').get('h1')).toEqual({ note: '저기서 고친 메모' });
    const conflict = db.prepare('SELECT entity, key, data FROM sync_conflicts').get() as { entity: string; key: string; data: string };
    expect(conflict).toMatchObject({ entity: 'highlight', key: 'h1' });
    expect(JSON.parse(conflict.data)).toMatchObject({ note: '여기서 고친 메모' });
  });

  it('waits with a translation until this device has the same block', async () => {
    addLocalPaper('p1');
    await syncOnce(transport);
    transport.put(`pl1/dev/${OTHER}/paper/p1.json`, bundleOf('p1', [
      ['translation', '1', later(), null, 0, { ko: '둘째 문단 번역', sentences: null, made_by: null, block: sha1('The second block.') }],
    ]));
    expect((await syncOnce(transport)).pending).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM translations WHERE paper_id=? AND block_idx=1').get('p1')).toEqual({ n: 0 });

    // e.g. this device re-extracts the PDF with the same app version as the other device
    db.prepare("INSERT INTO blocks(paper_id,idx,page,text,lines,page_w,page_h) VALUES('p1',1,1,'The second block.','[]',600,800)").run();
    expect((await syncOnce(transport)).pending).toBe(0);
    expect(db.prepare('SELECT ko FROM translations WHERE paper_id=? AND block_idx=1').get('p1')).toEqual({ ko: '둘째 문단 번역' });
  });

  it('merges a separately imported copy of the same DOI into the local paper', async () => {
    addLocalPaper('p1');
    db.prepare("UPDATE papers SET doi='10.1/same' WHERE id='p1'").run();
    transport.put(`pl1/dev/${OTHER}/paper/x9.json`, bundleOf('x9', [
      ['paper', '_', v(1), null, 0, { ...paperData('Same paper', null), doi: '10.1/same' }],
      ['artifact', 'mindmap', later(), null, 0, { content: '{"root":1}', meta: '{}', engine: null, made_by: null, updated_at: 'z' }],
    ]));
    await syncOnce(transport);
    expect(getPaper('x9')).toBeUndefined();
    expect(db.prepare("SELECT content FROM artifacts WHERE paper_id='p1' AND kind='mindmap'").get()).toEqual({ content: '{"root":1}' });
  });
});

describe('folder sync', () => {
  const folderData = (name: string) => ({ name, created_at: '2025-01-01', updated_at: '2025-01-02' });
  const insertFolder = (id: string, name: string) => {
    db.prepare('INSERT INTO folders(id,name,name_key,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(id, name, name.trim().toLowerCase(), '2025-01-01', '2025-01-02');
  };
  const remoteFolders = (rows: BundleRow[]) => transport.put(`pl1/dev/${OTHER}/folders.json`, bundleOf('', rows));

  it('publishes empty folders independently, renames them and retains deletion tombstones', async () => {
    insertFolder('f1', '연구');
    expect((await syncOnce(transport)).published).toBe(1);
    const path = `pl1/dev/${deviceId()}/folders.json`;
    let bundle = JSON.parse(transport.get(path)!.toString()) as Bundle;
    expect(bundle.paper).toBe('');
    expect(bundle.rows).toHaveLength(1);
    expect(bundle.rows[0]).toMatchObject(['folder', 'f1', expect.any(String), null, 0, folderData('연구')]);
    expect((await syncOnce(transport)).published).toBe(0);
    db.prepare("UPDATE folders SET name='새 연구',name_key='새 연구',updated_at='2025-02-01' WHERE id='f1'").run();
    await syncOnce(transport);
    bundle = JSON.parse(transport.get(path)!.toString()) as Bundle;
    expect(bundle.rows[0][5]).toMatchObject({ name: '새 연구', updated_at: '2025-02-01' });
    db.prepare("DELETE FROM folders WHERE id='f1'").run();
    await syncOnce(transport);
    bundle = JSON.parse(transport.get(path)!.toString()) as Bundle;
    expect(bundle.rows[0][4]).toBe(1);
    expect(bundle.rows[0][5]).toBeNull();
  });

  it('merges folder entities before assignments regardless of remote listing order', async () => {
    transport.put(`pl1/dev/${OTHER}/paper/r1.json`, bundleOf('r1', [
      ['paper', '_', v(1000), null, 0, paperData('Filed paper', null)],
      ['folder_assignment', '_', v(1001), null, 0, { folder_id: 'f1' }],
    ]));
    remoteFolders([['folder', 'f1', v(999), null, 0, folderData('연구')]]);
    expect((await syncOnce(transport)).pending).toBe(0);
    expect(getPaper('r1')).toMatchObject({ folder_id: 'f1' });
    expect(db.prepare("SELECT name FROM folders WHERE id='f1'").get()).toEqual({ name: '연구' });
    expect(state('r1', 'folder_assignment', '_')?.version).toBe(v(1001));
  });

  it('defers an assignment with its paper until its folder arrives without creating a winning empty assignment', async () => {
    transport.put(`pl1/dev/${OTHER}/paper/r1.json`, bundleOf('r1', [
      ['paper', '_', v(1000), null, 0, paperData('Filed paper', null)],
      ['folder_assignment', '_', v(1001), null, 0, { folder_id: 'f1' }],
    ]));
    expect((await syncOnce(transport)).pending).toBe(1);
    expect(getPaper('r1')).toBeUndefined();
    expect(state('r1', 'folder_assignment', '_')).toBeUndefined();
    remoteFolders([['folder', 'f1', v(999), null, 0, folderData('나중 폴더')]]);
    expect((await syncOnce(transport)).pending).toBe(0);
    expect(getPaper('r1')).toMatchObject({ folder_id: 'f1' });
    expect(state('r1', 'folder_assignment', '_')?.version).toBe(v(1001));
  });

  it('accepts old snapshots without removing an existing assignment and keeps assignment separate from metadata conflicts', async () => {
    insertFolder('f1', '연구');
    addLocalPaper('p1');
    db.prepare("UPDATE papers SET folder_id='f1' WHERE id='p1'").run();
    await syncOnce(transport);
    const assignmentVersion = state('p1', 'folder_assignment', '_')!.version;
    transport.put(`pl1/dev/${OTHER}/paper/p1.json`, bundleOf('p1', [
      ['paper', '_', later(), null, 0, paperData('Old snapshot metadata', null)],
    ]));
    await syncOnce(transport);
    expect(getPaper('p1')).toMatchObject({ title: 'Old snapshot metadata', folder_id: 'f1' });
    expect(state('p1', 'folder_assignment', '_')!.version).toBe(assignmentVersion);
    transport.put(`pl1/dev/${OTHER}/paper/p1.json`, bundleOf('p1', [
      ['folder_assignment', '_', v(Date.now() + 120_000), assignmentVersion, 0, { folder_id: null }],
    ]));
    await syncOnce(transport);
    expect(getPaper('p1')).toMatchObject({ title: 'Old snapshot metadata', folder_id: null });
  });

  it('applies rename and delete while retaining papers, and never resurrects a deleted folder from a stale assignment', async () => {
    insertFolder('f1', '연구');
    addLocalPaper('p1');
    db.prepare("UPDATE papers SET folder_id='f1' WHERE id='p1'").run();
    await syncOnce(transport);
    remoteFolders([['folder', 'f1', later(), null, 0, folderData('이름 변경')]]);
    await syncOnce(transport);
    expect(db.prepare("SELECT name FROM folders WHERE id='f1'").get()).toEqual({ name: '이름 변경' });
    expect(getPaper('p1')?.folder_id).toBe('f1');
    remoteFolders([['folder', 'f1', v(Date.now() + 120_000), null, 1, null]]);
    await syncOnce(transport);
    expect(getPaper('p1')).toMatchObject({ folder_id: null });
    expect(state('', 'folder', 'f1')?.deleted).toBe(1);
    transport.put(`pl1/dev/${OTHER}/paper/r1.json`, bundleOf('r1', [
      ['paper', '_', v(1000), null, 0, paperData('Stale filed paper', null)],
      ['folder_assignment', '_', v(1001), null, 0, { folder_id: 'f1' }],
    ]));
    expect((await syncOnce(transport)).pending).toBe(0);
    expect(getPaper('r1')).toMatchObject({ folder_id: null });
    expect(db.prepare("SELECT 1 FROM folders WHERE id='f1'").get()).toBeUndefined();
  });

  it('publishes local folder deletion and explicit unfiling without deleting paper content', async () => {
    insertFolder('f1', '연구');
    addLocalPaper('p1');
    db.prepare("UPDATE papers SET folder_id='f1' WHERE id='p1'").run();
    await syncOnce(transport);
    db.prepare("DELETE FROM folders WHERE id='f1'").run();
    await syncOnce(transport);
    const bundle = JSON.parse(transport.get(`pl1/dev/${deviceId()}/paper/p1.json`)!.toString()) as Bundle;
    expect(bundle.rows.find((r) => r[0] === 'folder_assignment')?.[5]).toEqual({ folder_id: null });
    expect(bundle.rows.find((r) => r[0] === 'paper')?.[4]).toBe(0);
    expect(getPaper('p1')).toBeDefined();
    expect(db.prepare("SELECT content FROM artifacts WHERE paper_id='p1' AND kind='summary'").get()).toEqual({ content: '요약' });
  });

  it('preserves independently created case-insensitive duplicate folders and both assignments', async () => {
    insertFolder('z-local', 'Research');
    addLocalPaper('p1');
    db.prepare("UPDATE papers SET folder_id='z-local' WHERE id='p1'").run();
    remoteFolders([['folder', 'a-remote', v(1000), null, 0, folderData('research')]]);
    transport.put(`pl1/dev/${OTHER}/paper/r1.json`, bundleOf('r1', [
      ['paper', '_', v(1001), null, 0, paperData('Remote research', null)],
      ['folder_assignment', '_', v(1002), null, 0, { folder_id: 'a-remote' }],
    ]));
    await syncOnce(transport);
    expect(getPaper('p1')?.folder_id).toBe('z-local');
    expect(getPaper('r1')?.folder_id).toBe('a-remote');
    const folders = db.prepare('SELECT name, name_key FROM folders ORDER BY id').all();
    expect(folders).toHaveLength(2);
    expect(folders[0].name).toBe('research');
    expect(folders[1].name).toMatch(/^Research \([0-9a-f]{16}\)$/);
    expect(new Set(folders.map((f) => f.name_key)).size).toBe(2);
  });
});
