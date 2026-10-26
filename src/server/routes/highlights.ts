import { existsSync, readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { db, getPaper, now } from '../db';
import { imagePath, imageUrl, removeImage, saveDataUrlPng } from '../images';
import { HttpError } from '../http-error';

export const highlights = new Hono();

const COLORS: Record<string, true> = { yellow: true, green: true, blue: true, pink: true };

interface HighlightRow {
  id: string;
  paper_id: string;
  type: 'text' | 'area';
  color: string;
  position: string;
  text: string | null;
  image_file: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export function highlightDto(h: HighlightRow) {
  return {
    id: h.id,
    type: h.type,
    color: h.color,
    position: JSON.parse(h.position) as unknown,
    text: h.text,
    imageUrl: imageUrl(h.image_file),
    note: h.note,
    createdAt: h.created_at,
  };
}

const getRow = (hid: string) => db.prepare('SELECT * FROM highlights WHERE id=?').get(hid) as HighlightRow | undefined;

highlights.get('/papers/:id/highlights', (c) => {
  const rows = db.prepare('SELECT * FROM highlights WHERE paper_id=? ORDER BY created_at').all(c.req.param('id')) as unknown as HighlightRow[];
  return c.json(rows.map(highlightDto));
});

highlights.post('/papers/:id/highlights', async (c) => {
  const paperId = c.req.param('id');
  if (!getPaper(paperId)) throw new HttpError(404, '논문을 찾을 수 없습니다');
  const body = await c.req.json<{
    type?: string;
    color?: string;
    position?: unknown;
    text?: string | null;
    imageDataUrl?: string | null;
    note?: string | null;
  }>();
  if (body.type !== 'text' && body.type !== 'area') throw new HttpError(400, 'type은 text 또는 area');
  if (!body.color || !Object.hasOwn(COLORS, body.color)) throw new HttpError(400, '알 수 없는 색');
  if (!body.position || typeof body.position !== 'object') throw new HttpError(400, 'position이 없습니다');
  const id = nanoid(12);
  const image = body.imageDataUrl ? saveDataUrlPng(body.imageDataUrl, id) : null;
  const t = now();
  db.prepare(
    'INSERT INTO highlights(id,paper_id,type,color,position,text,image_file,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
  ).run(id, paperId, body.type, body.color, JSON.stringify(body.position), body.text ?? null, image, body.note?.trim() || null, t, t);
  return c.json(highlightDto(getRow(id)!));
});

highlights.patch('/highlights/:hid', async (c) => {
  const h = getRow(c.req.param('hid'));
  if (!h) throw new HttpError(404, '하이라이트를 찾을 수 없습니다');
  const body = await c.req.json<{ color?: string; note?: string | null; position?: unknown; imageDataUrl?: string }>();
  if (body.color !== undefined && !Object.hasOwn(COLORS, body.color)) throw new HttpError(400, '알 수 없는 색');
  const image = body.imageDataUrl ? saveDataUrlPng(body.imageDataUrl, h.id) : h.image_file;
  db.prepare('UPDATE highlights SET color=?, note=?, position=?, image_file=?, updated_at=? WHERE id=?').run(
    body.color ?? h.color,
    body.note === undefined ? h.note : body.note?.trim() || null,
    body.position === undefined ? h.position : JSON.stringify(body.position),
    image,
    now(),
    h.id,
  );
  return c.json(highlightDto(getRow(h.id)!));
});

highlights.delete('/highlights/:hid', (c) => {
  const h = getRow(c.req.param('hid'));
  if (!h) throw new HttpError(404, '하이라이트를 찾을 수 없습니다');
  db.prepare('DELETE FROM highlights WHERE id=?').run(h.id);
  removeImage(h.image_file);
  return c.json({ ok: true });
});

highlights.get('/images/:file', (c) => {
  const file = c.req.param('file');
  if (!/^[A-Za-z0-9_-]+\.png$/.test(file) || !existsSync(imagePath(file))) throw new HttpError(404, '이미지가 없습니다');
  return c.body(readFileSync(imagePath(file)), 200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
});
