import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from './config';
import { HttpError } from './http-error';

/** Decode a `data:image/png;base64,…` URL into `images/<name>.png`; returns the file name. */
export function saveDataUrlPng(dataUrl: string, name: string): string {
  const m = /^data:image\/png;base64,(.+)$/s.exec(dataUrl);
  if (!m) throw new HttpError(400, 'PNG data URL이 아닙니다');
  const file = `${name}.png`;
  writeFileSync(join(PATHS.images, file), Buffer.from(m[1], 'base64'));
  return file;
}

export function removeImage(file: string | null | undefined) {
  if (file) rmSync(join(PATHS.images, file), { force: true });
}

export const imagePath = (file: string) => join(PATHS.images, file);
export const imageUrl = (file: string | null | undefined) => (file ? `/api/images/${file}` : null);
