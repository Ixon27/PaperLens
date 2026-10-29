import { randomBytes } from 'node:crypto';
import { db } from '../db';

/*
 * Sync bookkeeping. Each row the app syncs has a version: `<ms base36>.<counter base36>.<device>`.
 * Fixed-width parts make versions comparable as strings; the device suffix breaks ties.
 * `sync_rows` survives paper deletion so deletions travel as tombstones.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS sync_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_rows(paper_id TEXT NOT NULL, entity TEXT NOT NULL, key TEXT NOT NULL, version TEXT NOT NULL,
  base TEXT, hash TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(paper_id, entity, key));
CREATE TABLE IF NOT EXISTS sync_files(name TEXT PRIMARY KEY, file_id TEXT NOT NULL, checksum TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_published(paper_id TEXT PRIMARY KEY, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_alias(remote_id TEXT PRIMARY KEY, local_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_conflicts(id INTEGER PRIMARY KEY AUTOINCREMENT, paper_id TEXT NOT NULL, entity TEXT NOT NULL,
  key TEXT NOT NULL, version TEXT, data TEXT, replaced_by TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_file_hashes(path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime REAL NOT NULL, sha256 TEXT NOT NULL);
`);

export function getMeta(key: string): string | null {
  const row = db.prepare('SELECT value FROM sync_meta WHERE key=?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string | null): void {
  if (value === null) db.prepare('DELETE FROM sync_meta WHERE key=?').run(key);
  else db.prepare('INSERT INTO sync_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

export function deviceId(): string {
  let id = getMeta('device');
  if (!id) {
    id = randomBytes(8).toString('hex');
    setMeta('device', id);
  }
  return id;
}

/** Remote bookkeeping belongs to one Google account; a different account starts from a clean slate. */
export function useAccount(sub: string | null): void {
  if (getMeta('account') === sub) return;
  db.exec('DELETE FROM sync_files; DELETE FROM sync_published; DELETE FROM sync_alias');
  setMeta('account', sub);
}

const pad = (n: number, width: number) => n.toString(36).padStart(width, '0');

/** A hybrid logical clock: wall time when it moves forward, a counter otherwise, never behind any seen version. */
export class Clock {
  private ms = 0;
  private counter = 0;

  constructor(private readonly device: string) {
    const last = getMeta('clock');
    if (last) this.observe(last);
  }

  tick(): string {
    const now = Date.now();
    if (now > this.ms) {
      this.ms = now;
      this.counter = 0;
    } else {
      this.counter++;
    }
    return `${pad(this.ms, 10)}.${pad(this.counter, 4)}.${this.device}`;
  }

  observe(version: string): void {
    const [ms, counter] = version.split('.');
    const m = parseInt(ms, 36);
    const c = parseInt(counter, 36);
    if (!Number.isFinite(m) || !Number.isFinite(c)) return;
    if (m > this.ms || (m === this.ms && c > this.counter)) {
      this.ms = m;
      this.counter = c;
    }
  }

  save(): void {
    setMeta('clock', `${pad(this.ms, 10)}.${pad(this.counter, 4)}.${this.device}`);
  }
}
