import { beforeEach, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { Hono } from 'hono';

vi.mock('../src/server/config', () => ({ PATHS: { db: ':memory:' } }));
import { db } from '../src/server/db';
import { HttpError } from '../src/server/http-error';
import { libraryExportRoutes } from '../src/server/routes/library-export';
import { LIBRARY_COLUMNS, parseLibraryExportRequest } from '../src/server/export/library';

const app = new Hono();
app.onError((error, c) => c.json({ error: error.message }, error instanceof HttpError ? error.status : 500));
app.route('/api', libraryExportRoutes);
const request = (body: unknown) => app.request('/api/library/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  db.exec('DELETE FROM papers');
  const insert = db.prepare('INSERT INTO papers(id,title,authors,year,journal,doi,field,pdf_file,created_at,updated_at,last_opened_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  insert.run('a', '=evil|`한글`\\\n다음', JSON.stringify([{ given: '길동', family: '홍' }]), 2026, '물리 & <학술지>', '10.1/example', 'physics', 'a.pdf', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', null);
  insert.run('b', '+SUM(1,2)', '[]', null, null, null, null, null, '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z');
  db.prepare('INSERT INTO blocks(paper_id,idx,page,text,lines,page_w,page_h,is_ref,kind) VALUES(?,?,?,?,?,?,?,?,?)').run('a', 0, 1, 'English content', '[]', 100, 100, 0, 'body');
  db.prepare('INSERT INTO translations(paper_id,block_idx,ko) VALUES(?,?,?)').run('a', 0, '내용');
  db.prepare('INSERT INTO artifacts(paper_id,kind,content,updated_at) VALUES(?,?,?,?)').run('a', 'analysis', '분석', '2026-01-01');
});

it('round-trips real XLSX bytes with Unicode and literal formula-like text in explicit order without changing data', async () => {
  const before = db.prepare('SELECT * FROM papers ORDER BY id').all();
  const response = await request({ format: 'xlsx', ids: ['a', 'b'] });
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  expect(response.headers.get('Content-Disposition')).toContain("filename*=UTF-8''%EB");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await response.arrayBuffer());
  const sheet = workbook.getWorksheet('논문 목록')!;
  expect(sheet.getRow(1).values).toEqual([undefined, ...LIBRARY_COLUMNS]);
  expect(sheet.getCell('A2').value).toBe('=evil|`한글`\\\n다음');
  expect(sheet.getCell('A2').type).toBe(ExcelJS.ValueType.String);
  expect(sheet.getCell('A3').value).toBe('+SUM(1,2)');
  expect(sheet.getCell('B2').value).toBe('길동 홍');
  expect(sheet.getCell('F2').value).toBe('물리학');
  expect(sheet.getCell('H2').value).toBe('열지 않음');
  expect(sheet.getCell('J2').value).toBe('번역 완료 (1/1)');
  expect(sheet.getCell('K2').value).toBe('있음');
  expect(sheet.rowCount).toBe(3);
  expect(db.prepare('SELECT * FROM papers ORDER BY id').all()).toEqual(before);
});

it('exports all in recent order by default and only explicit rows for a selected scope', async () => {
  const all = await (await request({ format: 'md' })).text();
  expect(all.indexOf('+SUM(1,2)')).toBeLessThan(all.indexOf('=evil'));
  const selected = await (await request({ format: 'md', ids: ['a'] })).text();
  expect(selected).not.toContain('+SUM');
  expect(selected).toContain('=evil&#124;&#96;한글&#96;&#92;<br>다음');
  expect(selected).toContain('물리 &amp; &lt;학술지&gt;');
  const lines = selected.split('\n').filter((line) => line.startsWith('|'));
  expect(lines).toHaveLength(3);
  expect(lines.every((line) => (line.match(/\|/g) ?? []).length === LIBRARY_COLUMNS.length + 1)).toBe(true);
});

it.each([null, [], {}, { format: 'csv' }, { format: 'md', ids: [] }, { format: 'md', ids: null }, { format: 'md', ids: [''] }, { format: 'md', ids: [1] }, { format: 'md', ids: ['a', 'a'] }, { format: 'md', scope: 'all' }])('rejects invalid export request %j', async (body) => {
  expect(() => parseLibraryExportRequest(body)).toThrow(HttpError);
  expect((await request(body)).status).toBe(400);
});

it('rejects missing IDs atomically, treats SQL fragments as IDs, and rejects empty libraries', async () => {
  expect((await request({ format: 'md', ids: ['a', 'missing'] })).status).toBe(404);
  expect((await request({ format: 'xlsx', ids: ["' OR 1=1 --"] })).status).toBe(404);
  expect((await app.request('/api/library/export', { method: 'POST', body: '{' })).status).toBe(400);
  db.exec('DELETE FROM papers');
  const response = await request({ format: 'md' });
  expect(response.status).toBe(400);
});
