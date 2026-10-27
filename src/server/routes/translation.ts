import { Hono } from 'hono';
import { getPaper } from '../db';
import { HttpError } from '../http-error';
import { ensureCurrentLayout } from '../tasks/import';
import { startTranslation } from '../tasks/translation';

export const translation = new Hono();

translation.post('/papers/:id/translation', async (c) => {
  const paper = getPaper(c.req.param('id'));
  if (!paper) throw new HttpError(404, '논문을 찾을 수 없습니다');
  if (!paper.pdf_file) throw new HttpError(400, 'PDF를 먼저 붙이세요');
  const body = await c.req.json<{ force?: boolean }>().catch(() => ({ force: false }));
  const force = body.force === true;
  // Re-translating drops every translation, so it is also when an old block layout is replaced.
  if (force) await ensureCurrentLayout(paper.id, { force: true });
  return c.json({ jobId: startTranslation(paper.id, { force }) });
});
