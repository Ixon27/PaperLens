import { Hono } from 'hono';
import { db, isTranslatable, parseAuthors, type BlockRow, type PaperRow } from '../db';
import { libraryMarkdown, libraryXlsx, parseLibraryExportRequest, type LibraryExportPaper } from '../export/library';
import { HttpError } from '../http-error';

export const libraryExportRoutes = new Hono();

libraryExportRoutes.post('/library/export', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { throw new HttpError(400, 'JSON 요청이 올바르지 않습니다'); }
  const { format, ids } = parseLibraryExportRequest(body);
  let papers: PaperRow[];
  if (ids) {
    const find = db.prepare('SELECT * FROM papers WHERE id=?');
    papers = ids.map((id) => {
      const paper = find.get(id) as PaperRow | undefined;
      if (!paper) throw new HttpError(404, '내보낼 논문을 찾을 수 없습니다. 목록을 새로 고친 뒤 다시 시도하세요');
      return paper;
    });
  } else {
    papers = db.prepare('SELECT * FROM papers ORDER BY last_opened_at DESC NULLS LAST, created_at DESC, id').all() as unknown as PaperRow[];
  }
  if (!papers.length) throw new HttpError(400, '내보낼 논문이 없습니다');
  const blocks = db.prepare('SELECT idx, is_ref, text, kind FROM blocks WHERE paper_id=?');
  const translations = db.prepare('SELECT block_idx FROM translations WHERE paper_id=?');
  const analysis = db.prepare("SELECT 1 FROM artifacts WHERE paper_id=? AND kind='analysis'");
  const rows: LibraryExportPaper[] = papers.map((paper) => {
    const eligible = (blocks.all(paper.id) as Pick<BlockRow, 'idx' | 'is_ref' | 'text' | 'kind'>[]).filter(isTranslatable);
    // Count against exactly the translatable block set (not orphan/stale translations).
    const translatedIds = new Set((translations.all(paper.id) as { block_idx: number }[]).map((r) => r.block_idx));
    return { paper, authors: parseAuthors(paper), translation: { total: eligible.length, done: eligible.filter((b) => translatedIds.has(b.idx)).length }, analysis: !!analysis.get(paper.id) };
  });
  const filename = `논문-목록-${new Date().toISOString().slice(0, 10)}.${format}`;
  c.header('Content-Disposition', `attachment; filename="PaperLens-library.${format}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  c.header('Cache-Control', 'no-store');
  if (format === 'md') {
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    return c.body(libraryMarkdown(rows));
  }
  c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return c.body(await libraryXlsx(rows));
});
