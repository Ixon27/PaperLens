import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PATHS } from '../config';
import { db, getPaper, now, refreshFts, tx } from '../db';
import { paperHasActiveJob } from '../jobs';
import { deletePaper } from '../tasks/delete-paper';
import { extractPaperPdf, paperIdByDoi } from '../tasks/import';
import type { RemoteFile, SyncTransport } from './drive';
import {
  ENTITIES, applyPaper, applyRow, blockHashes, deleteRow, fileSha256, placePdf, readPaperRows, rowHash, sha1,
  type BlobFiles, type BlobSources, type Entity, type PaperRows, type RowData,
} from './rows';
import { Clock, deviceId, setMeta } from './state';

/*
 * Each device writes only its own files (`pl1/dev/<device>/paper/<paper>.json`), so no two devices
 * ever write the same Drive file; Drive has no compare-and-set. A device merges everyone else's
 * files row by row: the higher version wins, deletions are tombstones, and an overwritten local
 * edit that the winner never saw is kept in `sync_conflicts`. PDFs and images are uploaded once
 * as `pl1/blob/<sha256>`.
 */

export const FORMAT = 1;
const paperFile = (device: string, paperId: string) => `pl1/dev/${device}/paper/${paperId}.json`;
const blobFile = (sha: string) => `pl1/blob/${sha}`;
const PAPER_FILE = /^pl1\/dev\/([0-9a-f]+)\/paper\/([^/]+)\.json$/;
const DEVICE_OF = /^pl1\/dev\/([0-9a-f]+)\//;

/** `[entity, key, version, base, deleted, data]` */
export type BundleRow = [Entity, string, string, string | null, 0 | 1, RowData | null];
export interface Bundle {
  format: typeof FORMAT;
  device: string;
  paper: string;
  rows: BundleRow[];
}

export interface SyncResult {
  /** Rows taken from other devices. */
  applied: number;
  /** Own paper files uploaded. */
  published: number;
  /** Other devices' files to read again next time (busy paper, missing block or blob). */
  pending: number;
  devices: number;
}

interface RowState {
  version: string;
  base: string | null;
  hash: string;
  deleted: boolean;
}

const rowKey = (entity: string, key: string) => `${entity}\t${key}`;
const APPLY_ORDER: Record<Entity, number> = Object.fromEntries(ENTITIES.map((e, i) => [e, i])) as Record<Entity, number>;

function loadStates(paperId: string): Map<string, RowState> {
  const rows = db.prepare('SELECT entity, key, version, base, hash, deleted FROM sync_rows WHERE paper_id=?').all(paperId) as {
    entity: string; key: string; version: string; base: string | null; hash: string; deleted: number;
  }[];
  return new Map(rows.map((r) => [rowKey(r.entity, r.key), { version: r.version, base: r.base, hash: r.hash, deleted: r.deleted === 1 }]));
}

function setState(paperId: string, entity: string, key: string, s: RowState): void {
  db.prepare(`INSERT INTO sync_rows(paper_id,entity,key,version,base,hash,deleted) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(paper_id,entity,key) DO UPDATE SET version=excluded.version, base=excluded.base, hash=excluded.hash, deleted=excluded.deleted`)
    .run(paperId, entity, key, s.version, s.base, s.hash, s.deleted ? 1 : 0);
}

function recordConflict(paperId: string, entity: string, key: string, version: string | null, data: unknown, replacedBy: string): void {
  db.prepare('INSERT INTO sync_conflicts(paper_id,entity,key,version,data,replaced_by,at) VALUES(?,?,?,?,?,?,?)')
    .run(paperId, entity, key, version, data === undefined ? null : JSON.stringify(data), replacedBy, now());
}

function syncedPaperIds(): string[] {
  const ids = new Set((db.prepare('SELECT id FROM papers').all() as { id: string }[]).map((r) => r.id));
  for (const r of db.prepare('SELECT DISTINCT paper_id FROM sync_rows').all() as { paper_id: string }[]) ids.add(r.paper_id);
  return [...ids];
}

/** Give every new, changed or vanished row of every paper a fresh version. Papers with running jobs wait. */
function scan(clock: Clock, sources: BlobSources): void {
  tx(() => {
    for (const id of syncedPaperIds()) {
      if (paperHasActiveJob(id)) continue;
      const rows = readPaperRows(id, sources);
      const states = loadStates(id);
      const seen = new Set<string>();
      for (const [entity, byKey] of rows) {
        for (const [key, data] of byKey) {
          const k = rowKey(entity, key);
          seen.add(k);
          const hash = rowHash(data);
          const s = states.get(k);
          if (!s) setState(id, entity, key, { version: clock.tick(), base: null, hash, deleted: false });
          else if (s.deleted || s.hash !== hash) setState(id, entity, key, { version: clock.tick(), base: s.version, hash, deleted: false });
        }
      }
      for (const [k, s] of states) {
        if (seen.has(k) || s.deleted) continue;
        const [entity, key] = k.split('\t');
        setState(id, entity, key, { version: clock.tick(), base: s.version, hash: '', deleted: true });
      }
    }
  });
}

/** The local paper a remote paper id maps to: same id, a recorded alias, or the local paper with the same DOI. */
function localIdFor(remoteId: string, paperRow: BundleRow | undefined): string {
  const alias = db.prepare('SELECT local_id FROM sync_alias WHERE remote_id=?').get(remoteId)?.local_id;
  if (typeof alias === 'string') return alias;
  if (getPaper(remoteId) || db.prepare('SELECT 1 FROM sync_rows WHERE paper_id=? LIMIT 1').get(remoteId)) return remoteId;
  const doi = paperRow && !paperRow[4] && typeof paperRow[5]?.doi === 'string' ? paperRow[5].doi : null;
  const sameDoi = doi ? paperIdByDoi(doi) : null;
  if (sameDoi) {
    // The same paper imported separately on two devices: merge into the local one.
    db.prepare('INSERT OR REPLACE INTO sync_alias(remote_id,local_id) VALUES(?,?)').run(remoteId, sameDoi);
    return sameDoi;
  }
  return remoteId;
}

const isEntity = (v: unknown): v is Entity => typeof v === 'string' && (ENTITIES as readonly string[]).includes(v);

function isBundleRow(r: unknown): r is BundleRow {
  if (!Array.isArray(r) || r.length !== 6) return false;
  const [entity, key, version, base, deleted, data] = r;
  const dataOk = deleted === 1 ? data === null : typeof data === 'object' && data !== null && !Array.isArray(data);
  return isEntity(entity) && typeof key === 'string' && typeof version === 'string' && (base === null || typeof base === 'string') && (deleted === 0 || deleted === 1) && dataOk;
}

/** Another device's file, checked field by field; anything malformed is skipped. */
function parseBundle(buf: Buffer): Bundle | null {
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || !('format' in raw) || !('device' in raw) || !('paper' in raw) || !('rows' in raw)) return null;
  const { format, device, paper, rows } = raw;
  if (format !== FORMAT || typeof device !== 'string' || typeof paper !== 'string' || !Array.isArray(rows) || !rows.every(isBundleRow)) return null;
  return { format: FORMAT, device, paper, rows };
}

const imageBlob = (data: RowData | null) => (data && typeof data.image === 'string' ? data.image : null);

/** Merge one other device's view of a paper; 'pending' means read it again on a later sync. */
async function applyBundle(
  bundle: Bundle, transport: SyncTransport, remoteBlobs: Map<string, RemoteFile>, sources: BlobSources, clock: Clock,
): Promise<{ status: 'done' | 'pending'; applied: number }> {
  for (const r of bundle.rows) clock.observe(r[2]);
  const paperRow = bundle.rows.find((r) => r[0] === 'paper');
  const localId = localIdFor(bundle.paper, paperRow);
  if (paperHasActiveJob(localId)) return { status: 'pending', applied: 0 };

  const states = loadStates(localId);
  const local = getPaper(localId);
  const wins = (r: BundleRow) => {
    const s = states.get(rowKey(r[0], r[1]));
    return !s || r[2] > s.version;
  };
  const winners = bundle.rows.filter(wins);
  if (!winners.length) return { status: 'done', applied: 0 };
  const paperWin = winners.find((r) => r[0] === 'paper');
  const before: PaperRows | null = local ? readPaperRows(localId, new Map()) : null;

  if (paperWin?.[4]) {
    // Deleted elsewhere. Local changes made after that deletion keep the paper (and bring it back there).
    const newer = [...states.values()].some((s) => !s.deleted && s.version > paperWin[2]);
    if (local && newer) {
      const s = states.get(rowKey('paper', '_'))!;
      tx(() => setState(localId, 'paper', '_', { ...s, version: clock.tick(), base: paperWin[2] }));
      return { status: 'done', applied: 0 };
    }
    tx(() => {
      if (local) {
        recordConflict(localId, 'paper', '_', states.get(rowKey('paper', '_'))?.version ?? null, Object.fromEntries([...before!].map(([e, m]) => [e, Object.fromEntries(m)])), paperWin[2]);
        deletePaper(local);
      }
      for (const r of bundle.rows) setState(localId, r[0], r[1], { version: r[2], base: r[3], hash: '', deleted: true });
      for (const [k, s] of states) {
        const [entity, key] = k.split('\t');
        if (!s.deleted && !bundle.rows.some((r) => rowKey(r[0], r[1]) === k)) setState(localId, entity, key, { version: paperWin[2], base: s.version, hash: '', deleted: true });
      }
    });
    return { status: 'done', applied: bundle.rows.length };
  }
  // Rows of a paper this device does not have (and is not receiving now) — e.g. deleted here later.
  if (!local && !paperWin) return { status: 'done', applied: 0 };

  const paperData = paperWin?.[5] ?? null;
  const localPdfSha = local?.pdf_file ? fileSha256(join(PATHS.pdfs, local.pdf_file)) : null;
  const wantPdf = typeof paperData?.pdf === 'string' && paperData.pdf !== localPdfSha ? paperData.pdf : null;
  const needed = new Set<string>();
  if (wantPdf) needed.add(wantPdf);
  for (const r of winners) {
    const sha = r[4] ? null : imageBlob(r[5]);
    if (sha && !sources.has(sha)) needed.add(sha);
  }

  const tmp = mkdtempSync(join(PATHS.tmp, 'sync-'));
  try {
    const files: BlobFiles = new Map(sources);
    for (const sha of needed) {
      const remote = remoteBlobs.get(blobFile(sha));
      // The other device uploads blobs before its paper file, so this is only a race with its next sync.
      if (!remote) return { status: 'pending', applied: 0 };
      const data = await transport.read(remote.id);
      if (createHash('sha256').update(data).digest('hex') !== sha) throw new Error('Google Drive에서 받은 파일이 손상되었습니다');
      const path = join(tmp, sha);
      writeFileSync(path, data);
      files.set(sha, path);
    }

    let pdfReplaced = false;
    if (paperWin && paperData) {
      const s = states.get(rowKey('paper', '_'));
      const mine = before?.get('paper')?.get('_');
      tx(() => {
        if (s && mine && !s.deleted && paperWin[3] !== s.version && rowHash(mine) !== rowHash(paperData)) recordConflict(localId, 'paper', '_', s.version, mine, paperWin[2]);
        applyPaper(localId, paperData);
      });
      if (wantPdf) {
        placePdf(localId, wantPdf, files);
        await extractPaperPdf(localId);
        pdfReplaced = true;
      }
    }

    const blocks = blockHashes(localId);
    // A new PDF dropped every translation, so all of the other device's translations are candidates again.
    const candidates = pdfReplaced
      ? [...winners, ...bundle.rows.filter((r) => r[0] === 'translation' && !winners.includes(r))]
      : winners;
    candidates.sort((a, b) => APPLY_ORDER[a[0]] - APPLY_ORDER[b[0]]);
    let pending = false;
    const applied: BundleRow[] = [];
    tx(() => {
      for (const r of candidates) {
        const [entity, key, version, base, deleted, data] = r;
        if (entity === 'paper') {
          applied.push(r);
          continue;
        }
        const s = states.get(rowKey(entity, key));
        const mine = before?.get(entity)?.get(key);
        if (s && !s.deleted && mine && base !== s.version && version > s.version && (deleted || rowHash(mine) !== rowHash(data ?? {}))) {
          recordConflict(localId, entity, key, s.version, mine, version);
        }
        if (deleted) {
          deleteRow(localId, entity, key);
          applied.push(r);
        } else if (data && applyRow(localId, entity, key, data, files, blocks)) {
          applied.push(r);
        } else {
          pending = true;
        }
      }
      const after = readPaperRows(localId, sources);
      for (const [entity, key, version, base, deleted] of applied) {
        const data = after.get(entity)?.get(key);
        setState(localId, entity, key, { version, base, hash: data ? rowHash(data) : '', deleted: deleted === 1 || !data });
      }
    });
    refreshFts(localId);
    return { status: pending ? 'pending' : 'done', applied: applied.length };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function merge(transport: SyncTransport, device: string, files: RemoteFile[], sources: BlobSources, clock: Clock, signal?: AbortSignal) {
  const processed = new Map((db.prepare('SELECT name, checksum FROM sync_files').all() as { name: string; checksum: string }[]).map((r) => [r.name, r.checksum]));
  const remoteBlobs = new Map(files.filter((f) => f.name.startsWith('pl1/blob/')).map((f) => [f.name, f]));
  let applied = 0;
  let pending = 0;
  for (const f of files) {
    const m = PAPER_FILE.exec(f.name);
    if (!m || m[1] === device || processed.get(f.name) === f.checksum) continue;
    signal?.throwIfAborted();
    const bundle = parseBundle(await transport.read(f.id));
    const result = bundle ? await applyBundle(bundle, transport, remoteBlobs, sources, clock) : { status: 'done' as const, applied: 0 };
    applied += result.applied;
    if (result.status === 'pending') pending++;
    else db.prepare('INSERT INTO sync_files(name,file_id,checksum) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET file_id=excluded.file_id, checksum=excluded.checksum').run(f.name, f.id, f.checksum);
  }
  return { applied, pending };
}

/** Upload changed own paper files, after the PDFs and images they point at. */
async function publish(transport: SyncTransport, device: string, files: RemoteFile[], sources: BlobSources, signal?: AbortSignal): Promise<number> {
  const byName = new Map(files.map((f) => [f.name, f]));
  const own = new Map((db.prepare('SELECT name, file_id FROM sync_files').all() as { name: string; file_id: string }[]).map((r) => [r.name, r.file_id]));
  const published = new Map((db.prepare('SELECT paper_id, hash FROM sync_published').all() as { paper_id: string; hash: string }[]).map((r) => [r.paper_id, r.hash]));
  const outgoing: { paperId: string; name: string; body: string; hash: string }[] = [];
  const blobs = new Set<string>();
  for (const id of syncedPaperIds()) {
    if (paperHasActiveJob(id)) continue;
    const states = loadStates(id);
    if (!states.size) continue;
    const current = readPaperRows(id, sources);
    const rows: BundleRow[] = [];
    for (const [k, s] of [...states].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const [entity, key] = k.split('\t') as [Entity, string];
      const data = s.deleted ? null : current.get(entity)?.get(key) ?? null;
      if (!s.deleted && !data) continue;
      rows.push([entity, key, s.version, s.base, s.deleted ? 1 : 0, data]);
      for (const sha of [imageBlob(data), entity === 'paper' && typeof data?.pdf === 'string' ? data.pdf : null]) if (sha) blobs.add(sha);
    }
    const body = JSON.stringify({ format: FORMAT, device, paper: id, rows } satisfies Bundle);
    const hash = sha1(body);
    const name = paperFile(device, id);
    if (published.get(id) === hash && byName.has(name)) continue;
    outgoing.push({ paperId: id, name, body, hash });
  }
  if (!outgoing.length) return 0;
  for (const sha of blobs) {
    if (byName.has(blobFile(sha))) continue;
    const path = sources.get(sha);
    if (!path) continue;
    signal?.throwIfAborted();
    const created = await transport.create(blobFile(sha), readFileSync(path), 'application/octet-stream');
    byName.set(created.name, created);
  }
  for (const b of outgoing) {
    signal?.throwIfAborted();
    const existing = own.get(b.name) ?? byName.get(b.name)?.id;
    const data = Buffer.from(b.body, 'utf8');
    const file = existing ? await transport.update(existing, data, 'application/json') : await transport.create(b.name, data, 'application/json');
    tx(() => {
      db.prepare('INSERT INTO sync_files(name,file_id,checksum) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET file_id=excluded.file_id, checksum=excluded.checksum').run(b.name, file.id, file.checksum);
      db.prepare('INSERT INTO sync_published(paper_id,hash) VALUES(?,?) ON CONFLICT(paper_id) DO UPDATE SET hash=excluded.hash').run(b.paperId, b.hash);
    });
  }
  return outgoing.length;
}

/** One copy of the database before the first sync ever touches it. */
function backupOnce(): void {
  if (PATHS.db === ':memory:' || db.prepare("SELECT 1 FROM sync_meta WHERE key='backup'").get()) return;
  const target = join(dirname(PATHS.db), 'backups', `paper-reader-before-sync-${now().replace(/[:.]/g, '-')}.db`);
  mkdirSync(dirname(target), { recursive: true });
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  setMeta('backup', target);
}

export async function syncOnce(transport: SyncTransport, opts: { signal?: AbortSignal } = {}): Promise<SyncResult> {
  const device = deviceId();
  const clock = new Clock(device);
  backupOnce();
  let sources: BlobSources = new Map();
  scan(clock, sources);
  opts.signal?.throwIfAborted();
  let files = await transport.list();
  const merged = await merge(transport, device, files, sources, clock, opts.signal);
  sources = new Map();
  scan(clock, sources);
  if (merged.applied) files = await transport.list();
  const published = await publish(transport, device, files, sources, opts.signal);
  clock.save();
  setMeta('lastSyncAt', now());
  if (merged.applied) setMeta('changedAt', now());
  const devices = new Set([device, ...files.map((f) => DEVICE_OF.exec(f.name)?.[1]).filter((d): d is string => !!d)]);
  return { applied: merged.applied, published, pending: merged.pending, devices: devices.size };
}
