import { Hono } from 'hono';
import { presentationMarkdown } from '../../shared/presentation';
import { HttpError } from '../http-error';
import { presentationAnalysis, readPresentation, startPresentation } from '../tasks/presentation';
import { requirePaper } from './papers';

export const presentationRoutes = new Hono();

presentationRoutes.get('/papers/:id/presentation', (c) => {
  const paper = requirePaper(c.req.param('id'));
  return c.json({ presentation: readPresentation(paper.id), analysis: presentationAnalysis(paper.id).info });
});

presentationRoutes.post('/papers/:id/presentation', async (c) => {
  const paper = requirePaper(c.req.param('id'));
  let body: unknown;
  try { body = await c.req.json(); } catch { throw new HttpError(400, 'JSON 요청이 올바르지 않습니다'); }
  if (typeof body !== 'object' || body === null || !('durationMinutes' in body)) throw new HttpError(400, '발표 시간을 입력하세요');
  return c.json({ jobId: startPresentation(paper.id, body.durationMinutes) });
});

presentationRoutes.get('/papers/:id/presentation/export', (c) => {
  const paper = requirePaper(c.req.param('id'));
  const presentation = readPresentation(paper.id);
  if (!presentation) throw new HttpError(404, '내보낼 발표 자료가 없습니다');
  const filename = `${paper.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 100)}-${presentation.durationMinutes}분-발표.md`;
  c.header('Content-Type', 'text/markdown; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="PaperLens-presentation.md"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  c.header('Cache-Control', 'no-store');
  return c.body(presentationMarkdown(presentation));
});
