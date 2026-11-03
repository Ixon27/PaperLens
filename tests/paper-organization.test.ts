import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/server/config', () => ({
  PATHS: { db: ':memory:', pdfs: '/unused/pdfs', images: '/unused/images', tmp: '/unused/tmp', prompts: '/unused/prompts' },
  BIN: { claude: null, codex: null },
  EMAIL: null,
}));

import { db, getPaper, refreshFts } from '../src/server/db';
import { HttpError } from '../src/server/http-error';
import { papers } from '../src/server/routes/papers';
import { highlights } from '../src/server/routes/highlights';
import { applyPaper, applyRow, deleteRow, readPaperRows } from '../src/server/sync/rows';

const app = new Hono();
app.onError((error, c) => c.json({ error: error.message }, error instanceof HttpError ? error.status : 500));
app.route('/api', papers);
app.route('/api', highlights);

const jsonRequest = (path: string, method: string, body: unknown) => app.request(`/api${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const patch = (body: unknown) => jsonRequest('/papers/a', 'PATCH', body);
const search = async (query: string) => {
  const response = await app.request(`/api/papers?q=${encodeURIComponent(query)}`);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ id: string; searchMatch: { source: string; snippet: string; highlightId: string | null; page: number | null } }[]>;
};
const position = { boundingRect: { pageNumber: 3, x1: 1, y1: 1, x2: 20, y2: 10, width: 100, height: 100 }, rects: [] };

beforeEach(() => {
  db.exec('DELETE FROM papers; DELETE FROM papers_fts');
  const insert = db.prepare('INSERT INTO papers(id,title,authors,created_at,updated_at) VALUES(?,?,?,?,?)');
  insert.run('a', 'Quantum transport', JSON.stringify([{ given: 'Ada', family: 'Lovelace' }]), '2026-01-01', '2026-01-01');
  insert.run('b', 'Other result', '[]', '2026-02-01', '2026-02-01');
  db.prepare("INSERT INTO blocks(paper_id,idx,page,text,lines,page_w,page_h) VALUES('a',0,1,'Calibrated resonator measurements','[]',100,100)").run();
  refreshFts('a');
  refreshFts('b');
});

describe('explicit paper organization', () => {
  it('defaults to unstarred/unread and never infers read status from opening a paper', async () => {
    const response = await app.request('/api/papers/a');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ starred: false, readStatus: 'unread' });
    expect(getPaper('a')).toMatchObject({ starred: 0, read_status: 'unread', last_opened_at: expect.any(String) });
    expect(await (await app.request('/api/papers')).json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'a', starred: false, readStatus: 'unread' })]));
  });

  it('updates both flags independently, supports every state, and preserves flags on metadata edits', async () => {
    expect(await (await patch({ starred: true, readStatus: 'reading' })).json()).toMatchObject({ starred: true, readStatus: 'reading' });
    expect(await (await patch({ title: 'Edited title' })).json()).toMatchObject({ title: 'Edited title', starred: true, readStatus: 'reading' });
    expect(await (await patch({ readStatus: 'read' })).json()).toMatchObject({ starred: true, readStatus: 'read' });
    await app.request('/api/papers/a');
    expect(getPaper('a')?.read_status).toBe('read');
    expect(await (await patch({ starred: false, readStatus: 'unread' })).json()).toMatchObject({ starred: false, readStatus: 'unread' });
  });

  it.each([
    { starred: 1 }, { starred: 0 }, { starred: 'true' }, { starred: null }, { starred: [] },
    { readStatus: 'Read' }, { readStatus: 'done' }, { readStatus: '' }, { readStatus: null }, { readStatus: 1 }, { readStatus: {} },
    { starred: true, readStatus: 'invalid', title: 'Must not save' }, null, [], 'read',
  ])('rejects invalid flag input atomically: %j', async (body) => {
    const before = getPaper('a');
    expect((await patch(body)).status).toBe(400);
    expect(getPaper('a')).toEqual(before);
  });

  it('rejects malformed JSON and unknown papers without changing data', async () => {
    expect((await app.request('/api/papers/a', { method: 'PATCH', body: '{' })).status).toBe(400);
    expect((await jsonRequest('/papers/missing', 'PATCH', { starred: true })).status).toBe(404);
    expect(getPaper('a')).toMatchObject({ starred: 0, read_status: 'unread' });
  });
});

describe('library annotation search', () => {
  it.each([['Quantum', 'title'], ['Lovelace', 'authors'], ['resonator', 'body']])('retains original %s matching with a plain-text snippet', async (query, source) => {
    const rows = await search(query);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'a', searchMatch: { source, highlightId: null, page: null } });
    expect(rows[0].searchMatch.snippet.toLowerCase()).toContain(query.toLowerCase());
    expect(rows[0].searchMatch.snippet).not.toMatch(/[\u0001\u0002]/);
  });

  it('immediately reflects note creation, editing, clearing and deletion without refreshing paper FTS', async () => {
    const created = await jsonRequest('/papers/a/highlights', 'POST', { type: 'text', color: 'yellow', position, text: 'Novel phonon boundary', note: '기억할 재현성' });
    expect(created.status).toBe(200);
    const { id } = await created.json() as { id: string };
    expect(await search('재현성')).toEqual([expect.objectContaining({ id: 'a', searchMatch: { source: 'note', snippet: '기억할 재현성', highlightId: id, page: 3 } })]);
    expect((await search('phonon'))[0]).toMatchObject({ searchMatch: { source: 'highlight', highlightId: id, page: 3 } });
    expect((await jsonRequest(`/highlights/${id}`, 'PATCH', { note: '수정한 calibrationmemo' })).status).toBe(200);
    expect(await search('재현성')).toEqual([]);
    expect((await search('calibrationmemo'))[0].searchMatch.snippet).toContain('calibrationmemo');
    await jsonRequest(`/highlights/${id}`, 'PATCH', { note: null });
    expect(await search('calibrationmemo')).toEqual([]);
    expect(await search('phonon')).toHaveLength(1);
    expect((await app.request(`/api/highlights/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await search('phonon')).toEqual([]);
  });

  it('reflects sync-created, sync-replaced and sync-deleted highlights immediately', async () => {
    const remote = { type: 'text', color: 'yellow', position: JSON.stringify(position), text: 'remoteoriginal', note: 'firstremotenote' };
    expect(applyRow('a', 'highlight', 'remote', remote, new Map(), new Map())).toBe(true);
    expect((await search('firstremotenote'))[0]).toMatchObject({ id: 'a', searchMatch: { highlightId: 'remote', page: 3 } });
    applyRow('a', 'highlight', 'remote', { ...remote, text: 'replacementtext', note: 'secondremotenote' }, new Map(), new Map());
    expect(await search('firstremotenote')).toEqual([]);
    expect(await search('remoteoriginal')).toEqual([]);
    expect(await search('secondremotenote')).toHaveLength(1);
    deleteRow('a', 'highlight', 'remote');
    expect(await search('secondremotenote')).toEqual([]);
    expect(await search('replacementtext')).toEqual([]);
  });

  it('deduplicates paper and annotation matches and requires every annotation search term', async () => {
    await jsonRequest('/papers/a/highlights', 'POST', { type: 'text', color: 'yellow', position, text: 'Quantum', note: 'phonon firstnote' });
    await jsonRequest('/papers/a/highlights', 'POST', { type: 'area', color: 'blue', position, note: 'Quantum secondnote' });
    expect(await search('Quantum')).toHaveLength(1);
    expect((await search('Quantum phonon'))[0]).toMatchObject({ id: 'a', searchMatch: { source: 'note' } });
    expect(await search('phonon absent')).toEqual([]);
  });

  it('treats wildcard characters literally and does not search chats', async () => {
    await jsonRequest('/papers/a/highlights', 'POST', { type: 'text', color: 'yellow', position, note: '100% certain a_b' });
    await jsonRequest('/papers/b/highlights', 'POST', { type: 'text', color: 'yellow', position, note: '1000 certain acb' });
    expect((await search('100%')).map((row) => row.id)).toEqual(['a']);
    expect((await search('a_b')).map((row) => row.id)).toEqual(['a']);
    db.prepare("INSERT INTO threads(id,paper_id,title,created_at) VALUES('thread','b','chatuniquetext','x')").run();
    db.prepare("INSERT INTO messages(id,thread_id,role,content,created_at) VALUES('message','thread','user','chatuniquetext','x')").run();
    expect(await search('chatuniquetext')).toEqual([]);
  });
});

describe('organization sync round trips', () => {
  it.each(['unread', 'reading', 'read'])('round-trips a starred paper with %s state and applies explicit clearing', (readStatus) => {
    db.prepare('UPDATE papers SET starred=1, read_status=?, last_opened_at=? WHERE id=?').run(readStatus, '2026-03-01', 'a');
    const data = readPaperRows('a', new Map()).get('paper')!.get('_')!;
    expect(data).toMatchObject({ starred: 1, read_status: readStatus });
    applyPaper('copy', data);
    expect(getPaper('copy')).toMatchObject({ starred: 1, read_status: readStatus, last_opened_at: null });
    expect(readPaperRows('copy', new Map()).get('paper')!.get('_')).toEqual(data);
    applyPaper('copy', { ...data, starred: 0, read_status: 'unread' });
    expect(getPaper('copy')).toMatchObject({ starred: 0, read_status: 'unread' });
  });

  it('defaults legacy incoming papers and preserves local flags if an old bundle omits them', () => {
    const data = readPaperRows('a', new Map()).get('paper')!.get('_')!;
    delete data.starred;
    delete data.read_status;
    applyPaper('legacy', data);
    expect(getPaper('legacy')).toMatchObject({ starred: 0, read_status: 'unread' });
    db.prepare("UPDATE papers SET starred=1, read_status='read' WHERE id='a'").run();
    applyPaper('a', data);
    expect(getPaper('a')).toMatchObject({ starred: 1, read_status: 'read' });
    applyPaper('a', { ...data, starred: 'false', read_status: 'invalid' });
    expect(getPaper('a')).toMatchObject({ starred: 1, read_status: 'read' });
  });
});
