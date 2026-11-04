import { join } from 'node:path';
import { Hono } from 'hono';
import { PATHS } from '../config';
import { HttpError } from '../http-error';
import { openLayoutPdf, renderLayoutPage } from '../pdf/layout-translation';
import { readLayoutTranslation, startLayoutTranslation } from '../tasks/layout-translation';
import { requirePaper } from './papers';

export const layoutTranslationRoutes = new Hono();
let activeSourceRenders = 0;

layoutTranslationRoutes.get('/papers/:id/layout-translation', async (c) => {
  const paper = requirePaper(c.req.param('id'));
  c.header('Cache-Control', 'no-store');
  return c.json({ document: await readLayoutTranslation(paper.id) });
});

layoutTranslationRoutes.post('/papers/:id/layout-translation', async (c) => {
  const paper = requirePaper(c.req.param('id'));
  let body: unknown;
  try { body = await c.req.json(); }
  catch { throw new HttpError(400, 'JSON 요청이 올바르지 않습니다'); }
  return c.json({ jobId: await startLayoutTranslation(paper.id, body) });
});

/** The original page only: no translation paint, always the default PDF rotation. */
layoutTranslationRoutes.get('/papers/:id/layout-translation/source/:filename', async (c) => {
  const paper = requirePaper(c.req.param('id'));
  if (!paper.pdf_file) throw new HttpError(404, 'PDF가 없습니다');
  const match = /^([1-9]\d*)\.png$/.exec(c.req.param('filename'));
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new HttpError(400, 'PNG 페이지 번호가 올바르지 않습니다');
  if (activeSourceRenders >= 2) throw new HttpError(429, '원문 페이지 렌더링이 진행 중입니다');
  activeSourceRenders++;
  try {
    const opened = await openLayoutPdf(join(PATHS.pdfs, paper.pdf_file), c.req.raw.signal);
    try {
      const number = Number(match[1]);
      if (number > opened.pdf.numPages) throw new HttpError(400, '페이지 번호가 PDF 범위를 벗어났습니다');
      const page = await opened.pdf.getPage(number);
      try {
        const { canvas } = await renderLayoutPage(page, c.req.raw.signal);
        // Native canvas returns a Node Buffer backed by a regular ArrayBuffer.
        return c.body(canvas.toBuffer('image/png') as Uint8Array<ArrayBuffer>, 200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      } finally { page.cleanup(); }
    } finally { await opened.close(); }
  } finally { activeSourceRenders--; }
});
