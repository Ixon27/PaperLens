import { Hono } from 'hono';
import { getPaper } from '../db';
import { HttpError } from '../http-error';
import { startTranslation } from '../tasks/translation';

export const translation = new Hono();

translation.post('/papers/:id/translation', async (c) => {
  const paper = getPaper(c.req.param('id'));
  if (!paper) throw new HttpError(404, '논문을 찾을 수 없습니다');
  if (!paper.pdf_file) throw new HttpError(400, 'PDF를 먼저 붙이세요');
  const body = await c.req.json<{ force?: boolean }>().catch(() => ({ force: false }));
  return c.json({ jobId: startTranslation(paper.id, { force: body.force === true }) });
});
