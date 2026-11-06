import { db, now } from './db';
import { HttpError } from './http-error';

export interface FolderRow {
  id: string;
  name: string;
  name_key: string;
  created_at: string;
  updated_at: string;
}

export function normalizeFolderName(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, '폴더 이름을 입력하세요');
  const name = value.trim();
  if (!name || Array.from(name).length > 80) throw new HttpError(400, '폴더 이름은 공백을 제외하고 1~80자여야 합니다');
  return name;
}

export const folderNameKey = (name: string) => name.trim().toLowerCase();

export function requireFolder(id: string): FolderRow {
  const folder = db.prepare('SELECT * FROM folders WHERE id=?').get(id) as FolderRow | undefined;
  if (!folder) throw new HttpError(404, '폴더를 찾을 수 없습니다');
  return folder;
}

/** Omitted means preserve a duplicate's assignment; null explicitly means unfiled. */
export function folderInput(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, '폴더 ID가 올바르지 않습니다');
  requireFolder(value);
  return value;
}

/** A folder may disappear while import metadata or PDF extraction is awaiting I/O. */
export function survivingFolderId(folderId: string | null | undefined): string | null {
  return folderId && db.prepare('SELECT 1 FROM folders WHERE id=?').get(folderId) ? folderId : null;
}

export function assignImportedPaper(paperId: string, folderId: string | null | undefined): void {
  if (folderId === undefined) return;
  db.prepare('UPDATE papers SET folder_id=?, updated_at=? WHERE id=?').run(survivingFolderId(folderId), now(), paperId);
}
