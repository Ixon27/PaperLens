import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SYNC_SCOPES, type GoogleConfig } from './google-config';

export interface SecretStore {
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
  clear(): Promise<void>;
}

export interface GoogleAccount {
  email: string | null;
  sub: string | null;
}

interface StoredSecret extends GoogleAccount {
  refreshToken: string;
}

export class AuthExpiredError extends Error {
  constructor() {
    super('Google 연결이 만료되었습니다. 설정에서 다시 연결하세요');
    this.name = 'AuthExpiredError';
  }
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

interface PendingLogin {
  server: Server;
  timer: NodeJS.Timeout;
  reject: (err: Error) => void;
}

const SUCCESS_PAGE = '<!doctype html><meta charset="utf-8"><title>PaperLens</title>'
  + '<p style="font-family:system-ui;margin:3em;text-align:center">PaperLens에 연결되었습니다. 이 창을 닫아도 됩니다.</p>';
const DENIED_PAGE = '<!doctype html><meta charset="utf-8"><title>PaperLens</title>'
  + '<p style="font-family:system-ui;margin:3em;text-align:center">Google 연결을 취소했습니다. 이 창을 닫아도 됩니다.</p>';
const REFRESH_MARGIN_MS = 60_000;

const base64url = (buf: Buffer) => buf.toString('base64url');

function parseSecret(raw: string | null): StoredSecret | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredSecret>;
    if (typeof v.refreshToken !== 'string' || !v.refreshToken) return null;
    return {
      refreshToken: v.refreshToken,
      email: typeof v.email === 'string' ? v.email : null,
      sub: typeof v.sub === 'string' ? v.sub : null,
    };
  } catch {
    return null;
  }
}

// 토큰 엔드포인트에서 직접 받은 id_token 이라 서명 검증 없이 payload 만 읽는다.
function decodeIdToken(idToken: string | undefined): GoogleAccount {
  const payload = idToken?.split('.')[1];
  if (!payload) return { email: null, sub: null };
  try {
    const v = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown; sub?: unknown };
    return {
      email: typeof v.email === 'string' ? v.email : null,
      sub: typeof v.sub === 'string' ? v.sub : null,
    };
  } catch {
    return { email: null, sub: null };
  }
}

export class GoogleAuth {
  private readonly openBrowser?: (url: string) => Promise<void>;
  private readonly loginTimeoutMs: number;
  private pending: PendingLogin | null = null;
  private access: { token: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly cfg: GoogleConfig,
    private readonly store: SecretStore,
    opts: { openBrowser?: (url: string) => Promise<void>; loginTimeoutMs?: number } = {},
  ) {
    this.openBrowser = opts.openBrowser;
    this.loginTimeoutMs = opts.loginTimeoutMs ?? 300_000;
  }

  get configured(): boolean {
    return this.cfg.clientId.length > 0;
  }

  async connected(): Promise<boolean> {
    return parseSecret(await this.store.load()) !== null;
  }

  async account(): Promise<GoogleAccount | null> {
    const s = parseSecret(await this.store.load());
    return s ? { email: s.email, sub: s.sub } : null;
  }

  async beginLogin(): Promise<{ url: string; done: Promise<GoogleAccount> }> {
    if (!this.configured) throw new Error('Google OAuth 클라이언트가 설정되지 않았습니다');
    this.cancelPending(new Error('취소됨'));

    const verifier = base64url(randomBytes(48)); // 64자
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(24));
    const server = createServer();
    const listening = Promise.withResolvers<void>();
    server.once('error', listening.reject);
    server.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    server.off('error', listening.reject);
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

    const url = new URL(this.cfg.authUrl);
    url.search = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SYNC_SCOPES.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent',
    }).toString();

    const { promise: done, resolve, reject } = Promise.withResolvers<GoogleAccount>();
    let settled = false;
    let exchanging = false;
    const finish = (err: Error | null, account?: GoogleAccount) => {
      if (settled) return;
      settled = true;
      clearTimeout(pending.timer);
      if (this.pending === pending) this.pending = null;
      server.close();
      server.closeAllConnections();
      if (err) reject(err);
      else resolve(account!);
    };
    const pending: PendingLogin = {
      server,
      timer: setTimeout(() => finish(new Error('로그인 시간이 초과되었습니다')), this.loginTimeoutMs),
      reject: (err) => finish(err),
    };
    const badRequest = (res: ServerResponse) =>
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end('잘못된 요청입니다');
    server.on('request', (req, res) => {
      const reqUrl = new URL(req.url ?? '/', redirectUri);
      const q = reqUrl.searchParams;
      if (req.method !== 'GET' || reqUrl.pathname !== '/' || q.get('state') !== state || exchanging) {
        badRequest(res);
        return;
      }
      const error = q.get('error');
      if (error) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }).end(DENIED_PAGE);
        finish(new Error(error === 'access_denied' ? 'Google 연결을 취소했습니다' : `Google 로그인 오류: ${error}`));
        return;
      }
      const code = q.get('code');
      if (!code) {
        badRequest(res);
        return;
      }
      exchanging = true;
      this.exchangeCode(code, verifier, redirectUri).then(
        (account) => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }).end(SUCCESS_PAGE);
          finish(null, account);
        },
        (err: unknown) => {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end('연결에 실패했습니다');
          finish(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
    this.pending = pending;

    const href = url.toString();
    if (this.openBrowser) await this.openBrowser(href).catch(() => {});
    return { url: href, done };
  }

  async accessToken(force = false): Promise<string> {
    if (!force && this.access && this.access.expiresAt - REFRESH_MARGIN_MS > Date.now()) return this.access.token;
    // 동시 요청이 각자 refresh 하지 않도록 하나의 promise 를 공유한다.
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async disconnect(): Promise<void> {
    this.cancelPending(new Error('취소됨'));
    const secret = parseSecret(await this.store.load());
    if (secret) {
      await fetch(this.cfg.revokeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: secret.refreshToken }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
    }
    await this.store.clear();
    this.access = null;
  }

  private cancelPending(err: Error): void {
    const p = this.pending;
    this.pending = null;
    p?.reject(err);
  }

  private async tokenRequest(params: Record<string, string>): Promise<{ status: number; body: TokenResponse }> {
    const form = new URLSearchParams({ ...params, client_id: this.cfg.clientId });
    if (this.cfg.clientSecret) form.set('client_secret', this.cfg.clientSecret);
    const res = await fetch(this.cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as TokenResponse;
    return { status: res.status, body };
  }

  private async exchangeCode(code: string, verifier: string, redirectUri: string): Promise<GoogleAccount> {
    const { status, body } = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    if (status !== 200 || !body.access_token) {
      throw new Error(`Google 토큰 발급 실패 (${status}): ${body.error ?? '알 수 없는 오류'}`);
    }
    if (!body.refresh_token) throw new Error('Google이 refresh token을 주지 않았습니다. 다시 연결하세요');
    const account = decodeIdToken(body.id_token);
    await this.store.save(JSON.stringify({ refreshToken: body.refresh_token, ...account } satisfies StoredSecret));
    this.access = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return account;
  }

  private async refresh(): Promise<string> {
    const secret = parseSecret(await this.store.load());
    if (!secret) throw new AuthExpiredError();
    const { status, body } = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: secret.refreshToken });
    if (body.error === 'invalid_grant') {
      this.access = null;
      await this.store.clear();
      throw new AuthExpiredError();
    }
    if (status !== 200 || !body.access_token) {
      throw new Error(`Google 토큰 갱신 실패 (${status}): ${body.error ?? '알 수 없는 오류'}`);
    }
    this.access = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    // Google 이 refresh token 을 교체해 주면 새 값을 저장한다.
    if (body.refresh_token && body.refresh_token !== secret.refreshToken) {
      await this.store.save(JSON.stringify({ ...secret, refreshToken: body.refresh_token } satisfies StoredSecret));
    }
    return body.access_token;
  }
}
