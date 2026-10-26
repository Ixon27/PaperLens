import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { PATHS, PORT } from './config';
import { HttpError } from './http-error';
import { api } from './routes/index';

export interface ServerOptions {
  port?: number;
  token?: string;
  production?: boolean;
}

/** One app instance per backend process. Desktop callers supply a fresh token and port 0. */
export function createApp({ token, production = process.env.NODE_ENV === 'production' }: ServerOptions = {}) {
  const app = new Hono();
  const authorization = token ? `Bearer ${token}` : null;
  app.use('*', async (c, next) => {
    if (authorization && c.req.header('Authorization') !== authorization) return c.json({ error: '앱 인증이 필요합니다' }, 401);
    const origin = c.req.header('Origin');
    if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: '다른 웹사이트의 요청은 허용하지 않습니다' }, 403);
    if (production) {
      c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    }
    return next();
  });
  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
    if (error instanceof HTTPException) return c.json({ error: error.message || '잘못된 요청' }, error.status);
    console.error(error);
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  });
  app.route('/api', api);
  app.all('/api/*', c => c.json({ error: '없는 API입니다' }, 404));
  if (production) {
    app.use('/*', serveStatic({ root: PATHS.dist }));
    const indexFile = join(PATHS.dist, 'index.html');
    const html = existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : null;
    app.get('*', c => html ? c.html(html) : c.text('앱 화면 빌드가 없습니다 — npm run build 를 먼저 실행하세요', 500));
  }
  return app;
}

/** Start listening only when explicitly called (safe to import from the Electron utility process). */
export async function startServer(options: ServerOptions = {}): Promise<ServerType> {
  const app = createApp(options);
  const { promise, resolve, reject } = Promise.withResolvers<ServerType>();
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: options.port ?? PORT }, info => {
    console.log(`paper-reader API http://127.0.0.1:${info.port}  (DB ${PATHS.db})`);
    resolve(server);
  });
  server.once('error', reject);
  return promise;
}
