import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DriveTransport } from '../src/server/sync/drive';
import { AuthExpiredError, GoogleAuth, type SecretStore } from '../src/server/sync/google-auth';
import { googleConfig, type GoogleConfig } from '../src/server/sync/google-config';
import { startFakeGoogle, type FakeGoogle } from './fixtures/fake-google';

function memoryStore(initial: string | null = null): SecretStore & { value: string | null } {
  const store = {
    value: initial,
    load: async () => store.value,
    save: async (v: string) => {
      store.value = v;
    },
    clear: async () => {
      store.value = null;
    },
  };
  return store;
}

// openBrowser 대신 실제 HTTP 로 fake /auth 를 열고 302 를 따라 루프백 콜백까지 간다.
async function browse(url: string): Promise<Response> {
  return fetch(url);
}

async function login(auth: GoogleAuth) {
  const { url, done } = await auth.beginLogin();
  const page = await browse(url);
  return { url, page, account: await done };
}

let fake: FakeGoogle;
let cfg: GoogleConfig;

afterEach(async () => {
  await fake?.close();
});

describe('google-config', () => {
  it('uses Google defaults and env overrides', () => {
    const d = googleConfig({});
    expect(d.authUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(d.apiUrl).toBe('https://www.googleapis.com');
    expect(googleConfig({ PAPERLENS_GOOGLE_CLIENT_ID: 'x', PAPERLENS_GOOGLE_API_URL: 'http://a/' })).toMatchObject({ clientId: 'x', apiUrl: 'http://a' });
  });
});

describe('GoogleAuth', () => {
  beforeEach(async () => {
    fake = await startFakeGoogle();
    cfg = googleConfig(fake.env);
  });

  it('logs in through loopback + PKCE and stores the account', async () => {
    const store = memoryStore();
    const opened: string[] = [];
    const auth = new GoogleAuth(cfg, store, { openBrowser: async (u) => void opened.push(u) });
    expect(auth.configured).toBe(true);
    expect(await auth.connected()).toBe(false);

    const { url, done } = await auth.beginLogin();
    expect(opened).toEqual([url]);
    const q = new URL(url).searchParams;
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('prompt')).toBe('consent');
    expect(q.get('scope')).toBe('openid email https://www.googleapis.com/auth/drive.appdata');
    const redirect = q.get('redirect_uri')!;
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    // 다른 state 의 콜백은 400 이고 로그인은 계속 기다린다.
    const forged = await fetch(`${redirect}?code=stolen&state=wrong`);
    expect(forged.status).toBe(400);
    const wrongPath = await fetch(`${redirect}other?state=${q.get('state')}&code=x`);
    expect(wrongPath.status).toBe(400);

    const page = await browse(url);
    expect(page.status).toBe(200);
    expect(page.url.startsWith(redirect)).toBe(true);
    expect(await page.text()).toContain('PaperLens에 연결되었습니다. 이 창을 닫아도 됩니다.');
    expect(await done).toEqual({ email: 'reader@example.com', sub: 'fake-sub-1' });

    expect(JSON.parse(store.value!)).toMatchObject({ email: 'reader@example.com', sub: 'fake-sub-1', refreshToken: expect.stringMatching(/^refresh-/) });
    expect(await auth.connected()).toBe(true);
    expect(await auth.account()).toEqual({ email: 'reader@example.com', sub: 'fake-sub-1' });
    expect(await auth.accessToken()).toMatch(/^access-/);
    // 로그인이 끝나면 루프백 서버는 닫힌다.
    await expect(fetch(redirect)).rejects.toThrow();
  });

  it('rejects a PKCE verifier that does not match the challenge', async () => {
    const auth = new GoogleAuth(cfg, memoryStore());
    const { url, done } = await auth.beginLogin();
    const settled = expect(done).rejects.toThrow(/invalid_grant/);
    const tampered = new URL(url);
    tampered.searchParams.set('code_challenge', createHash('sha256').update('other-verifier-other-verifier-other-verifier').digest('base64url'));
    await fetch(tampered);
    await settled;
    expect(await auth.connected()).toBe(false);
  });

  it('rejects when the user denies access', async () => {
    fake.deny = true;
    const store = memoryStore();
    const auth = new GoogleAuth(cfg, store);
    const { url, done } = await auth.beginLogin();
    const settled = expect(done).rejects.toThrow('Google 연결을 취소했습니다');
    await browse(url);
    await settled;
    expect(store.value).toBeNull();
  });

  it('cancels the previous login and times out', async () => {
    const auth = new GoogleAuth(cfg, memoryStore(), { loginTimeoutMs: 50 });
    const first = await auth.beginLogin();
    const firstSettled = expect(first.done).rejects.toThrow('취소됨');
    const second = await auth.beginLogin();
    await firstSettled;
    await expect(second.done).rejects.toThrow('로그인 시간이 초과되었습니다');
  });

  it('refreshes within a minute of expiry, sharing one refresh between concurrent callers', async () => {
    await fake.close();
    fake = await startFakeGoogle({ accessTokenTtlSec: 30 }); // shorter than the 60 s margin: every call refreshes
    cfg = googleConfig(fake.env);
    const auth = new GoogleAuth(cfg, memoryStore());
    await login(auth);
    const a = await auth.accessToken();
    const b = await auth.accessToken();
    expect(a).not.toBe(b);
    const [c, d] = await Promise.all([auth.accessToken(), auth.accessToken()]);
    expect(c).toBe(d);
  });

  it('keeps a fresh access token cached until a forced refresh', async () => {
    const auth = new GoogleAuth(cfg, memoryStore());
    await login(auth);
    const first = await auth.accessToken();
    expect(await auth.accessToken()).toBe(first);
    const forced = await auth.accessToken(true);
    expect(forced).not.toBe(first);
    expect(await auth.accessToken()).toBe(forced);
  });

  it('clears the store on invalid_grant', async () => {
    const store = memoryStore(JSON.stringify({ refreshToken: 'refresh-unknown', email: 'a@b.c', sub: 's' }));
    const auth = new GoogleAuth(cfg, store);
    expect(await auth.connected()).toBe(true);
    const err = await auth.accessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthExpiredError);
    expect((err as Error).message).toBe('Google 연결이 만료되었습니다. 설정에서 다시 연결하세요');
    expect(store.value).toBeNull();
    expect(await auth.connected()).toBe(false);
  });

  it('revokes on disconnect', async () => {
    const store = memoryStore();
    const auth = new GoogleAuth(cfg, store);
    await login(auth);
    const refresh = (JSON.parse(store.value!) as { refreshToken: string }).refreshToken;
    await auth.disconnect();
    expect(fake.revoked).toEqual([refresh]);
    expect(store.value).toBeNull();
    await expect(auth.accessToken()).rejects.toBeInstanceOf(AuthExpiredError);
  });
});

describe('DriveTransport', () => {
  let auth: GoogleAuth;
  let drive: DriveTransport;

  beforeEach(async () => {
    fake = await startFakeGoogle({ pageSize: 2 });
    cfg = googleConfig(fake.env);
    auth = new GoogleAuth(cfg, memoryStore());
    await login(auth);
    drive = new DriveTransport(cfg, auth);
  });

  it('creates, lists across pages, reads, updates and removes', async () => {
    const md5 = (s: string) => createHash('md5').update(s).digest('hex');
    const created = [];
    for (const n of ['a', 'b', 'c', 'd', 'e']) {
      created.push(await drive.create(`${n}.json`, Buffer.from(`data-${n}`), 'application/json'));
    }
    expect(created[0]).toEqual({ id: expect.any(String), name: 'a.json', checksum: md5('data-a'), size: 6 });

    const listed = await drive.list();
    expect(listed.map((f) => f.name)).toEqual(['a.json', 'b.json', 'c.json', 'd.json', 'e.json']);

    expect((await drive.read(created[2].id)).toString()).toBe('data-c');

    const updated = await drive.update(created[2].id, Buffer.from('changed!'), 'application/json');
    expect(updated).toEqual({ id: created[2].id, name: 'c.json', checksum: md5('changed!'), size: 8 });
    expect(fake.files.get(created[2].id)?.data.toString()).toBe('changed!');

    await drive.remove(created[0].id);
    expect(fake.files.has(created[0].id)).toBe(false);
    expect((await drive.list()).length).toBe(4);
    await expect(drive.read(created[0].id)).rejects.toThrow(/Google Drive 오류 \(404\)/);
  });

  it('refreshes the token once on 401', async () => {
    fake.expireAccessTokens();
    await drive.create('x.bin', Buffer.from([1, 2, 3]), 'application/octet-stream');
    expect(fake.files.size).toBe(1);
  });

  it('retries rate limits and server errors with backoff', async () => {
    fake.failures.push({ status: 503 }, { status: 403, reason: 'userRateLimitExceeded' });
    expect(await drive.list()).toEqual([]);
    expect(fake.failures).toEqual([]);
  });

  it('gives up after four tries', async () => {
    fake.failures.push({ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 });
    await expect(drive.list()).rejects.toThrow('Google Drive 오류 (500): fake failure 500');
    expect(fake.failures.length).toBe(1);
  }, 20_000);

  it('reports a full Drive', async () => {
    fake.failures.push({ status: 403, reason: 'storageQuotaExceeded' });
    await expect(drive.create('big.bin', Buffer.alloc(10), 'application/octet-stream')).rejects.toThrow('Google Drive 저장 공간이 부족합니다');
  });
});
