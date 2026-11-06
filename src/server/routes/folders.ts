import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { db, now, tx } from '../db';
import { folderNameKey, normalizeFolderName, requireFolder, type FolderRow } from '../folders';
import { HttpError } from '../http-error';

export const folders = new Hono();
const folderDto = (folder: FolderRow) => ({
  id: folder.id, name: folder.name, createdAt: folder.created_at, updatedAt: folder.updated_at,
});

async function readName(request: { json(): Promise<unknown> }): Promise<string> {
  const body = await request.json().catch(() => { throw new HttpError(400, '올바른 JSON 변경 내용을 보내세요'); });
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '폴더 변경 내용은 객체여야 합니다');
  return normalizeFolderName((body as Record<string, unknown>).name);
}

function checkUniqueName(name: string, exceptId = ''): void {
  if (db.prepare('SELECT 1 FROM folders WHERE name_key=? AND id<>?').get(folderNameKey(name), exceptId)) {
    throw new HttpError(400, '같은 이름의 폴더가 이미 있습니다');
  }
}

folders.get('/folders', (c) => {
  const rows = db.prepare('SELECT * FROM folders ORDER BY name_key, id').all() as unknown as FolderRow[];
  return c.json(rows.map(folderDto));
});

folders.post('/folders', async (c) => {
  const name = await readName(c.req);
  const folder = tx(() => {
    checkUniqueName(name);
    const id = nanoid(10);
    const timestamp = now();
    db.prepare('INSERT INTO folders(id,name,name_key,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(id, name, folderNameKey(name), timestamp, timestamp);
    return requireFolder(id);
  });
  return c.json(folderDto(folder));
});

folders.put('/folders/:id', async (c) => {
  const id = c.req.param('id');
  requireFolder(id);
  const name = await readName(c.req);
  const folder = tx(() => {
    requireFolder(id);
    checkUniqueName(name, id);
    db.prepare('UPDATE folders SET name=?, name_key=?, updated_at=? WHERE id=?').run(name, folderNameKey(name), now(), id);
    return requireFolder(id);
  });
  return c.json(folderDto(folder));
});

folders.delete('/folders/:id', (c) => {
  const id = c.req.param('id');
  tx(() => {
    requireFolder(id);
    db.prepare('UPDATE papers SET folder_id=NULL, updated_at=? WHERE folder_id=?').run(now(), id);
    db.prepare('DELETE FROM folders WHERE id=?').run(id);
  });
  return c.json({ ok: true });
});
