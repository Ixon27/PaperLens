import { Hono } from 'hono';
import { getArtifact, madeByOf, putArtifact } from '../db';
import { HttpError } from '../http-error';
import { startMindmap, type MindmapContent } from '../tasks/mindmap';
import { requirePaper } from './papers';

export const mindmap = new Hono();

mindmap.post('/papers/:id/mindmap', (c) => {
  const p = requirePaper(c.req.param('id'));
  return c.json({ jobId: startMindmap(p.id) });
});

mindmap.put('/papers/:id/artifacts/mindmap/positions', async (c) => {
  const p = requirePaper(c.req.param('id'));
  const a = getArtifact(p.id, 'mindmap');
  if (!a) throw new HttpError(404, '마인드맵이 아직 없습니다');
  const body = await c.req.json<{ positions?: unknown }>().catch(() => ({}) as { positions?: unknown });
  const raw = body.positions;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new HttpError(400, 'positions가 없습니다');
  const positions: MindmapContent['positions'] = {};
  for (const [id, v] of Object.entries(raw)) {
    if (typeof v !== 'object' || v === null) continue;
    const { x, y } = v as { x?: unknown; y?: unknown };
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) positions[id] = { x, y };
  }
  const content = JSON.parse(a.content) as MindmapContent;
  putArtifact(p.id, 'mindmap', JSON.stringify({ root: content.root, positions }), JSON.parse(a.meta) as object, madeByOf(a));
  return c.json({ ok: true });
});
