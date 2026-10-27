import { Hono } from 'hono';
import { parseAnchor } from '../../shared/explain';
import { isFigureKind, type FigureSpec } from '../../shared/figure-spec';
import { resolveAnchor } from '../anchors';
import { db, getPaper, madeByOf } from '../db';
import { HttpError } from '../http-error';
import { imageUrl } from '../images';
import { activeKeyedJobs } from '../jobs';
import { startFigure } from '../tasks/figures';

export const figures = new Hono();

figures.get('/papers/:id/figures', (c) => {
  const paper = getPaper(c.req.param('id'));
  if (!paper) throw new HttpError(404, '논문을 찾을 수 없습니다');
  const rows = db.prepare('SELECT anchor,spec,image_file,made_by,updated_at FROM figures WHERE paper_id=? ORDER BY updated_at').all(paper.id) as unknown as {
    anchor: string; spec: string; image_file: string | null; made_by: string | null; updated_at: string;
  }[];
  const items = rows.flatMap((row) => {
    let spec: FigureSpec;
    try { spec = JSON.parse(row.spec) as FigureSpec; } catch { return []; }
    return [{ anchor: row.anchor, spec, imageUrl: imageUrl(row.image_file), by: madeByOf({ made_by: row.made_by, engine: null }), updatedAt: row.updated_at }];
  });
  const running = activeKeyedJobs(paper.id, 'figure').map(({ key, id }) => ({ anchor: key, jobId: id }));
  return c.json({ items, running });
});

figures.post('/papers/:id/figures', async (c) => {
  const paper = getPaper(c.req.param('id'));
  if (!paper) throw new HttpError(404, '논문을 찾을 수 없습니다');
  const body = await c.req.json<{ anchor?: unknown; imageDataUrl?: unknown; kind?: unknown }>().catch(() => ({} as { anchor?: unknown; imageDataUrl?: unknown; kind?: unknown }));
  const anchor = parseAnchor(body.anchor);
  if (!anchor) throw new HttpError(400, '그림 위치가 올바르지 않습니다');
  if (anchor.type === 'section') throw new HttpError(400, '그림이나 표만 인터랙티브로 만들 수 있습니다');
  resolveAnchor(paper.id, anchor);
  if (typeof body.imageDataUrl !== 'string' || !body.imageDataUrl.startsWith('data:image/png;base64,')) throw new HttpError(400, '그림 이미지가 없습니다');
  const kind = body.kind;
  if (kind != null && kind !== 'auto' && !isFigureKind(kind)) throw new HttpError(400, '알 수 없는 위젯 종류입니다');
  return c.json({ jobId: startFigure(paper.id, anchor, body.imageDataUrl, kind == null || kind === 'auto' ? null : kind) });
});
