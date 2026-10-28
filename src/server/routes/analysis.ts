import { Hono } from 'hono';
import { getPaper, type PaperRow } from '../db';
import { HttpError } from '../http-error';
import { isAddon, startAddons, type AddonId } from '../tasks/addons';
import { startAnalysis } from '../tasks/analysis';
import { startSummary } from '../tasks/summary';

export const analysis = new Hono();

function requirePaper(id: string): PaperRow {
  const paper = getPaper(id);
  if (!paper) throw new HttpError(404, '논문을 찾을 수 없습니다');
  return paper;
}


analysis.post('/papers/:id/analysis', (c) => {
  const paper = requirePaper(c.req.param('id'));
  return c.json({ jobId: startAnalysis(paper.id) });
});

analysis.post('/papers/:id/addons', async (c) => {
  const paper = requirePaper(c.req.param('id'));
  const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown } | null;
  const raw = Array.isArray(body?.ids) ? body.ids : [];
  const ids: AddonId[] = [...new Set(raw.filter(isAddon))];
  if (!ids.length || ids.length !== raw.length) throw new HttpError(400, '추가 분석을 하나 이상 고르세요');
  return c.json({ jobId: startAddons(paper.id, ids) });
});

analysis.post('/papers/:id/summary', (c) => {
  const paper = requirePaper(c.req.param('id'));
  return c.json({ jobId: startSummary(paper.id) });
});
