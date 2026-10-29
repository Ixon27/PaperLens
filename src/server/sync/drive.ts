import type { GoogleAuth } from './google-auth';
import type { GoogleConfig } from './google-config';

export interface RemoteFile {
  id: string;
  name: string;
  checksum: string;
  size: number;
}

export interface SyncTransport {
  list(): Promise<RemoteFile[]>;
  read(id: string): Promise<Buffer>;
  create(name: string, data: Buffer, mime: string): Promise<RemoteFile>;
  update(id: string, data: Buffer, mime: string): Promise<RemoteFile>;
  remove(id: string): Promise<void>;
}

interface DriveFile {
  id: string;
  name: string;
  md5Checksum?: string;
  size?: string;
}

const FILE_FIELDS = 'id,name,md5Checksum,size';
const MAX_TRIES = 4;
const BACKOFF_BASE_MS = 500;

const toRemote = (f: DriveFile): RemoteFile => ({
  id: f.id,
  name: f.name,
  checksum: f.md5Checksum ?? '',
  size: Number(f.size ?? 0),
});

async function errorInfo(res: Response): Promise<{ reason: string; message: string }> {
  const text = await res.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { error?: { message?: string; errors?: { reason?: string }[] } | string };
    if (typeof body.error === 'object' && body.error) {
      return { reason: body.error.errors?.[0]?.reason ?? '', message: body.error.message ?? res.statusText };
    }
    if (typeof body.error === 'string') return { reason: body.error, message: body.error };
  } catch {
    // JSON 이 아닌 오류 본문
  }
  return { reason: '', message: text.slice(0, 200) || res.statusText };
}

export class DriveTransport implements SyncTransport {
  constructor(
    private readonly cfg: GoogleConfig,
    private readonly auth: Pick<GoogleAuth, 'accessToken'>,
  ) {}

  async list(): Promise<RemoteFile[]> {
    const out: RemoteFile[] = [];
    let pageToken = '';
    do {
      const q = new URLSearchParams({ spaces: 'appDataFolder', fields: `nextPageToken,files(${FILE_FIELDS})`, pageSize: '1000' });
      if (pageToken) q.set('pageToken', pageToken);
      const res = await this.request(() => ({ url: `${this.cfg.apiUrl}/drive/v3/files?${q}` }));
      const body = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
      for (const f of body.files ?? []) out.push(toRemote(f));
      pageToken = body.nextPageToken ?? '';
    } while (pageToken);
    return out;
  }

  async read(id: string): Promise<Buffer> {
    const res = await this.request(() => ({ url: `${this.cfg.apiUrl}/drive/v3/files/${encodeURIComponent(id)}?alt=media` }));
    return Buffer.from(await res.arrayBuffer());
  }

  create(name: string, data: Buffer, mime: string): Promise<RemoteFile> {
    return this.upload('POST', `${this.cfg.apiUrl}/upload/drive/v3/files`, { name, parents: ['appDataFolder'] }, data, mime);
  }

  update(id: string, data: Buffer, mime: string): Promise<RemoteFile> {
    return this.upload('PATCH', `${this.cfg.apiUrl}/upload/drive/v3/files/${encodeURIComponent(id)}`, {}, data, mime);
  }

  async remove(id: string): Promise<void> {
    const res = await this.request(() => ({ url: `${this.cfg.apiUrl}/drive/v3/files/${encodeURIComponent(id)}`, method: 'DELETE' }));
    await res.body?.cancel();
  }

  // 세션 시작과 바이트 전송을 한 단위로 재시도한다. 중간에 끊긴 세션을 이어 올리는 것보다 단순하고, 동기화 파일은 작다.
  private async upload(method: 'POST' | 'PATCH', base: string, meta: object, data: Buffer, mime: string): Promise<RemoteFile> {
    const q = new URLSearchParams({ uploadType: 'resumable', fields: FILE_FIELDS });
    const start = await this.request(() => ({
      url: `${base}?${q}`,
      method,
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': mime,
        'x-upload-content-length': String(data.length),
      },
      body: JSON.stringify(meta),
    }));
    await start.body?.cancel();
    const location = start.headers.get('location');
    if (!location) throw new Error('Google Drive 오류: 업로드 주소를 받지 못했습니다');
    const res = await this.request(() => ({
      url: location,
      method: 'PUT',
      headers: { 'content-type': mime },
      body: new Uint8Array(data),
    }));
    return toRemote((await res.json()) as DriveFile);
  }

  private async request(build: () => { url: string; method?: string; headers?: Record<string, string>; body?: BodyInit }): Promise<Response> {
    let refreshed = false;
    let forceToken = false;
    for (let attempt = 1; ; attempt++) {
      const { url, method = 'GET', headers = {}, body } = build();
      const token = await this.auth.accessToken(forceToken);
      forceToken = false;
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: { ...headers, authorization: `Bearer ${token}` },
          body,
          signal: AbortSignal.timeout(120_000),
        });
      } catch (err) {
        if (attempt >= MAX_TRIES) throw new Error(`Google Drive에 연결하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
        await backoff(attempt);
        continue;
      }
      if (res.ok) return res;
      if (res.status === 401 && !refreshed) {
        await res.body?.cancel();
        refreshed = true;
        forceToken = true;
        attempt--; // 토큰 갱신 재시도는 백오프 횟수에 넣지 않는다
        continue;
      }
      const { reason, message } = await errorInfo(res);
      if (res.status === 403 && reason === 'storageQuotaExceeded') throw new Error('Google Drive 저장 공간이 부족합니다');
      const rateLimited = res.status === 403 && (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded');
      const retryable = res.status === 429 || res.status >= 500 || rateLimited;
      if (!retryable || attempt >= MAX_TRIES) throw new Error(`Google Drive 오류 (${res.status}): ${message}`);
      await backoff(attempt);
    }
  }
}

function backoff(attempt: number): Promise<void> {
  const ms = BACKOFF_BASE_MS * 2 ** (attempt - 1) * (0.5 + Math.random());
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
