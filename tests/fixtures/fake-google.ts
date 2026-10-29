import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeGoogle {
  url: string;
  env: Record<string, string>;
  files: Map<string, { name: string; data: Buffer }>;
  deny: boolean;
  revoked: string[];
  // 테스트용: 다음 Drive 요청들이 차례로 이 상태로 실패한다.
  failures: { status: number; reason?: string }[];
  // 테스트용: 발급된 access token 을 모두 무효로 만든다.
  expireAccessTokens(): void;
  close(): Promise<void>;
}

const CLIENT_ID = 'fake-client.apps.googleusercontent.com';
const ACCOUNT = { email: 'reader@example.com', sub: 'fake-sub-1' };

const token = (prefix: string) => `${prefix}-${randomBytes(12).toString('hex')}`;
const md5 = (data: Buffer) => createHash('md5').update(data).digest('hex');

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
}

function driveError(res: ServerResponse, status: number, message: string, reason = ''): void {
  json(res, status, { error: { code: status, message, errors: reason ? [{ reason, message }] : [] } });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export async function startFakeGoogle(opts: { pageSize?: number; accessTokenTtlSec?: number } = {}): Promise<FakeGoogle> {
  const ttl = opts.accessTokenTtlSec ?? 3600;
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const refreshTokens = new Set<string>();
  const accessTokens = new Map<string, number>(); // token → 만료 시각(ms)
  const uploads = new Map<string, { fileId: string | null; name: string | null }>();
  let nextFileId = 1;

  const issueAccess = () => {
    const t = token('access');
    accessTokens.set(t, Date.now() + ttl * 1000);
    return t;
  };

  const fileJson = (id: string) => {
    const f = fake.files.get(id)!;
    return { id, name: f.name, md5Checksum: md5(f.data), size: String(f.data.length) };
  };

  async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = new URLSearchParams((await readBody(req)).toString('utf8'));
    if (form.get('client_id') !== CLIENT_ID) return json(res, 401, { error: 'invalid_client' });
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') {
      const entry = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      const ok = entry
        && entry.redirectUri === form.get('redirect_uri')
        && createHash('sha256').update(verifier).digest('base64url') === entry.challenge;
      if (!ok) return json(res, 400, { error: 'invalid_grant' });
      const refresh = token('refresh');
      refreshTokens.add(refresh);
      const idToken = [
        Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
        Buffer.from(JSON.stringify(ACCOUNT)).toString('base64url'),
        '',
      ].join('.');
      return json(res, 200, { access_token: issueAccess(), expires_in: ttl, refresh_token: refresh, token_type: 'Bearer', id_token: idToken });
    }
    if (grant === 'refresh_token' && refreshTokens.has(form.get('refresh_token') ?? '')) {
      return json(res, 200, { access_token: issueAccess(), expires_in: ttl, token_type: 'Bearer' });
    }
    json(res, 400, { error: 'invalid_grant' });
  }

  function handleAuth(url: URL, res: ServerResponse): void {
    const q = url.searchParams;
    const redirect = q.get('redirect_uri') ?? '';
    const valid = q.get('client_id') === CLIENT_ID
      && q.get('response_type') === 'code'
      && q.get('code_challenge_method') === 'S256'
      && /^[A-Za-z0-9._~-]{43,128}$/.test(q.get('code_challenge') ?? '')
      && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(redirect)
      && (q.get('scope') ?? '').split(' ').includes('https://www.googleapis.com/auth/drive.appdata')
      && !!q.get('state');
    if (!valid) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('invalid auth request');
      return;
    }
    const target = new URL(redirect);
    if (fake.deny) {
      target.searchParams.set('error', 'access_denied');
    } else {
      const code = token('code');
      codes.set(code, { challenge: q.get('code_challenge')!, redirectUri: redirect });
      target.searchParams.set('code', code);
    }
    target.searchParams.set('state', q.get('state')!);
    res.writeHead(302, { location: target.toString() }).end();
  }

  async function handleDrive(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const exp = accessTokens.get(bearer);
    if (!exp || exp <= Date.now()) return driveError(res, 401, 'Invalid Credentials', 'authError');
    const failure = fake.failures.shift();
    if (failure) return driveError(res, failure.status, `fake failure ${failure.status}`, failure.reason);

    const q = url.searchParams;
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/drive/v3/files' && method === 'GET') {
      if (q.get('spaces') !== 'appDataFolder') return driveError(res, 400, 'spaces must be appDataFolder');
      const size = Math.min(Number(q.get('pageSize') ?? 100), opts.pageSize ?? 1000);
      const offset = Number(q.get('pageToken') ?? 0);
      const ids = [...fake.files.keys()];
      const page = ids.slice(offset, offset + size);
      const next = offset + size < ids.length ? String(offset + size) : undefined;
      return json(res, 200, { files: page.map(fileJson), ...(next ? { nextPageToken: next } : {}) });
    }

    const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (fileMatch) {
      const id = decodeURIComponent(fileMatch[1]);
      const f = fake.files.get(id);
      if (!f) return driveError(res, 404, `File not found: ${id}`, 'notFound');
      if (method === 'DELETE') {
        fake.files.delete(id);
        res.writeHead(204).end();
        return;
      }
      if (method === 'GET' && q.get('alt') === 'media') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(f.data);
        return;
      }
      if (method === 'GET') return json(res, 200, fileJson(id));
    }

    const uploadMatch = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(path);
    if (uploadMatch && q.get('uploadType') === 'resumable') {
      const uploadId = q.get('upload_id');
      if (uploadId && method === 'PUT') {
        const session = uploads.get(uploadId);
        if (!session) return driveError(res, 404, 'Upload session not found');
        uploads.delete(uploadId);
        const data = await readBody(req);
        const id = session.fileId ?? `file-${nextFileId++}`;
        const name = session.name ?? fake.files.get(id)?.name ?? id;
        fake.files.set(id, { name, data });
        return json(res, 200, fileJson(id));
      }
      const meta = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { name?: string; parents?: string[] };
      let session: { fileId: string | null; name: string | null };
      if (method === 'POST' && !uploadMatch[1]) {
        if (!meta.name || meta.parents?.[0] !== 'appDataFolder') return driveError(res, 400, 'create needs name and appDataFolder parent');
        session = { fileId: null, name: meta.name };
      } else if (method === 'PATCH' && uploadMatch[1]) {
        const id = decodeURIComponent(uploadMatch[1]);
        if (!fake.files.has(id)) return driveError(res, 404, `File not found: ${id}`, 'notFound');
        session = { fileId: id, name: meta.name ?? null };
      } else {
        return driveError(res, 405, 'method not allowed');
      }
      const sessionId = token('upload');
      uploads.set(sessionId, session);
      const location = new URL(url.pathname, fake.url);
      location.searchParams.set('uploadType', 'resumable');
      location.searchParams.set('upload_id', sessionId);
      res.writeHead(200, { location: location.toString() }).end();
      return;
    }

    driveError(res, 404, `Not found: ${method} ${path}`);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', fake.url);
    const run = async () => {
      if (url.pathname === '/auth' && req.method === 'GET') return handleAuth(url, res);
      if (url.pathname === '/token' && req.method === 'POST') return handleToken(req, res);
      if (url.pathname === '/revoke' && req.method === 'POST') {
        const t = new URLSearchParams((await readBody(req)).toString('utf8')).get('token') ?? '';
        fake.revoked.push(t);
        refreshTokens.delete(t);
        accessTokens.delete(t);
        res.writeHead(200).end();
        return;
      }
      if (url.pathname.startsWith('/drive/') || url.pathname.startsWith('/upload/drive/')) return handleDrive(req, url, res);
      res.writeHead(404).end();
    };
    run().catch((err: unknown) => {
      if (!res.headersSent) json(res, 500, { error: { message: String(err) } });
      else res.end();
    });
  });

  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const fake: FakeGoogle = {
    url: base,
    env: {
      PAPERLENS_GOOGLE_CLIENT_ID: CLIENT_ID,
      PAPERLENS_GOOGLE_CLIENT_SECRET: 'fake-secret',
      PAPERLENS_GOOGLE_AUTH_URL: `${base}/auth`,
      PAPERLENS_GOOGLE_TOKEN_URL: `${base}/token`,
      PAPERLENS_GOOGLE_REVOKE_URL: `${base}/revoke`,
      PAPERLENS_GOOGLE_API_URL: base,
    },
    files: new Map(),
    deny: false,
    revoked: [],
    failures: [],
    expireAccessTokens: () => accessTokens.clear(),
    close: async () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      server.closeAllConnections();
      await closed.promise;
    },
  };
  return fake;
}
