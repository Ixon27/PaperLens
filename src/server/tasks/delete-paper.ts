import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config';
import { db, type PaperRow } from '../db';

/** Delete a paper with its PDF, attached images and every dependent row. */
export function deletePaper(p: Pick<PaperRow, 'id' | 'pdf_file'>): void {
  const images = [
    ...(db.prepare('SELECT image_file FROM highlights WHERE paper_id=? AND image_file IS NOT NULL').all(p.id) as { image_file: string }[]),
    ...(db.prepare('SELECT image_file FROM figures WHERE paper_id=? AND image_file IS NOT NULL').all(p.id) as { image_file: string }[]),
    ...(db
      .prepare('SELECT m.image_file FROM messages m JOIN threads t ON t.id=m.thread_id WHERE t.paper_id=? AND m.image_file IS NOT NULL')
      .all(p.id) as { image_file: string }[]),
  ];
  for (const { image_file } of images) rmSync(join(PATHS.images, image_file), { force: true });
  if (p.pdf_file) rmSync(join(PATHS.pdfs, p.pdf_file), { force: true });
  db.prepare('DELETE FROM papers WHERE id=?').run(p.id);
  db.prepare('DELETE FROM papers_fts WHERE paper_id=?').run(p.id);
}
