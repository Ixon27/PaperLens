import { EMAIL } from '../config';

const UA = EMAIL ? `paper-reader/1.0 (mailto:${EMAIL})` : 'paper-reader/1.0';
const TIMEOUT_MS = 20_000;

/** GET with UA, 20 s timeout and one retry on 429/5xx; null on 404. */
async function get(url: string, accept: string): Promise<Response | null> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
    return res;
  }
}

export async function getJson<T = unknown>(url: string): Promise<T | null> {
  const res = await get(url, 'application/json');
  return res ? ((await res.json()) as T) : null;
}

export async function getText(url: string): Promise<string | null> {
  const res = await get(url, '*/*');
  return res ? await res.text() : null;
}

export async function getBuffer(url: string): Promise<Buffer | null> {
  const res = await get(url, 'application/pdf,*/*');
  return res ? Buffer.from(await res.arrayBuffer()) : null;
}
