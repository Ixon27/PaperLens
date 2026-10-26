import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { BIN, PATHS, PORT, POPPLER_MISSING } from './config';
import './db';
import { api } from './routes/index';
import { HttpError } from './http-error';

if (!BIN.pdftotext) console.error(POPPLER_MISSING);

const app = new Hono();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  if (err instanceof HTTPException) return c.json({ error: err.message || '잘못된 요청' }, err.status);
  console.error(err);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
});

app.route('/api', api);
app.all('/api/*', (c) => c.json({ error: '없는 API입니다' }, 404));

if (process.env.NODE_ENV === 'production') {
  app.use('/*', serveStatic({ root: './dist' }));
  const indexHtml = join(PATHS.dist, 'index.html');
  app.get('*', (c) => {
    if (!existsSync(indexHtml)) return c.text('dist/index.html 이 없습니다 — npm run build 를 먼저 실행하세요', 500);
    return c.html(readFileSync(indexHtml, 'utf8'));
  });
}

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: PORT }, (info) => {
  console.log(`paper-reader API http://127.0.0.1:${info.port}  (DB ${PATHS.db})`);
});
