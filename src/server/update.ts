import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from './config';
import { db } from './db';
import { getSettings } from './settings';

const LATEST_RELEASE = 'https://api.github.com/repos/Ixon27/PaperLens/releases/latest';
const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 8_000;

interface CachedRelease {
  checkedAt: string;
  latest: string | null;
  url: string | null;
}

export interface UpdateStatus {
  current: string;
  latest: string | null;
  url: string | null;
  /** A newer release the reader has not closed the notice for. */
  available: boolean;
}

/** `0.10.0` > `0.9.3`; a leading `v` and anything after `-` are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

const appVersion = () => (JSON.parse(readFileSync(join(PATHS.root, 'package.json'), 'utf8')) as { version: string }).version;

function cached(): CachedRelease | null {
  const row = db.prepare("SELECT value FROM settings WHERE key='updateCheck'").get() as { value: string } | undefined;
  try {
    return row ? (JSON.parse(row.value) as CachedRelease) : null;
  } catch {
    return null;
  }
}

/** One small request to GitHub per day; offline or rate-limited simply means "no notice". */
async function latestRelease(): Promise<CachedRelease | null> {
  const last = cached();
  if (last && Date.now() - Date.parse(last.checkedAt) < DAY_MS) return last;
  try {
    const res = await fetch(LATEST_RELEASE, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PaperLens' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return last;
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
    const fresh: CachedRelease = {
      checkedAt: new Date().toISOString(),
      latest: typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : null,
      url: typeof body.html_url === 'string' ? body.html_url : null,
    };
    db.prepare("INSERT INTO settings(key,value) VALUES('updateCheck',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(fresh));
    return fresh;
  } catch {
    return last;
  }
}

export async function checkForUpdate(): Promise<UpdateStatus> {
  const current = appVersion();
  const settings = getSettings();
  const release = settings.updateCheck ? await latestRelease() : null;
  const latest = release?.latest ?? null;
  return {
    current,
    latest,
    url: release?.url ?? null,
    available: Boolean(latest && compareVersions(latest, current) > 0 && latest !== settings.dismissedUpdate),
  };
}
