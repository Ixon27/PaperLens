import { Hono } from 'hono';
import { getPaper, type PaperRow } from '../db';
import { HttpError } from '../http-error';
import { isAddon, startAddons, type AddonId } from '../tasks/addons';
import { startAnalysis } from '../tasks/analysis';
import { classifyPaper, isResearchType, type ResearchType } from '../tasks/classify';
import { startSummary } from '../tasks/summary';

export const analysis = new Hono();

function requirePaper(id: string): PaperRow {
  const paper = getPaper(id);
  if (!paper) throw new HttpError(404, '논문을 찾을 수 없습니다');
  return paper;
}

analysis.post('/papers/:id/classify', async (c) => {
  const paper = requirePaper(c.req.param('id'));
  try {
    return c.json(await classifyPaper(paper));
  } catch (e) {
    throw new HttpError(502, e instanceof Error ? e.message : String(e));
  }
});

analysis.post('/papers/:id/analysis', async (c) => {
  const paper = requirePaper(c.req.param('id'));
  const body = (await c.req.json().catch(() => ({}))) as { types?: unknown };
  const raw = Array.isArray(body.types) ? body.types : [];
  const types: ResearchType[] = [...new Set(raw.filter(isResearchType))];
  if (!types.length || types.length !== raw.length) throw new HttpError(400, '연구 유형을 하나 이상 고르세요');
  return c.json({ jobId: startAnalysis(paper.id, types) });
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
