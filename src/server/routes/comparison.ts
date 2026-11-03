import { Hono } from 'hono';
import { comparisonMarkdown } from '../../shared/comparison';
import { HttpError } from '../http-error';
import { listComparisons, readComparison, startComparison } from '../tasks/comparison';

export const comparisonRoutes = new Hono();
comparisonRoutes.get('/comparisons', (c) => c.json({ comparisons: listComparisons() }));
comparisonRoutes.post('/comparisons', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { throw new HttpError(400, '비교 요청 JSON이 올바르지 않습니다'); }
  if (!body || typeof body !== 'object' || !('paperIds' in body)) throw new HttpError(400, '비교할 논문을 선택하세요');
  return c.json(startComparison(body.paperIds), 202);
});
comparisonRoutes.get('/comparisons/:id', (c) => c.json({ comparison: readComparison(c.req.param('id')) }));
comparisonRoutes.get('/comparisons/:id/markdown', (c) => {
  const result = readComparison(c.req.param('id'));
  c.header('Content-Type', 'text/markdown; charset=utf-8');
  c.header('Content-Disposition', 'attachment; filename="paper-comparison.md"');
  return c.body(comparisonMarkdown(result));
});
