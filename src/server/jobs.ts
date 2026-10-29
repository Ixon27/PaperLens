import { nanoid } from 'nanoid';
import { db, now } from './db';

export type JobKind = 'import' | 'translation' | 'analysis' | 'addons' | 'summary' | 'mindmap' | 'references' | 'keywords' | 'figure' | 'lineage';
export type JobStatus = 'queued' | 'running' | 'done' | 'error';

export interface JobRow {
  id: string;
  paper_id: string | null;
  kind: JobKind;
  status: JobStatus;
  progress: number;
  message: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobEvent {
  event: 'snapshot' | 'status' | 'progress' | 'delta' | 'text' | 'page' | 'done' | 'error' | (string & {});
  data: unknown;
}

export interface JobCtx {
  jobId: string;
  signal: AbortSignal;
  progress(p: number, message?: string): void;
  message(message: string): void;
  /** Append streamed text (kept for late subscribers' snapshot). */
  delta(text: string, extra?: Record<string, unknown>): void;
  /** Replace the accumulated text (e.g. after discarding a retried attempt). */
  setText(text: string): void;
  emit(event: string, data: unknown): void;
}

type Listener = (e: JobEvent) => void;
interface LiveJob {
  row: JobRow;
  key: string | null;
  text: string;
  listeners: Set<Listener>;
  abort: AbortController;
  finished: Promise<void>;
}

const live = new Map<string, LiveJob>();
const KEEP_FINISHED_MS = 60_000;

function persist(row: JobRow) {
  row.updated_at = now();
  db.prepare('UPDATE jobs SET status=?, progress=?, message=?, error=?, updated_at=? WHERE id=?').run(
    row.status,
    row.progress,
    row.message,
    row.error,
    row.updated_at,
    row.id,
  );
}

function broadcast(job: LiveJob, e: JobEvent) {
  for (const l of job.listeners) l(e);
}

export function snapshotOf(row: JobRow, text = '') {
  return {
    id: row.id,
    paperId: row.paper_id,
    kind: row.kind,
    status: row.status,
    progress: row.progress,
    message: row.message,
    error: row.error,
    text,
  };
}

export function activeJob(paperId: string, kind: JobKind, key: string | null = null): JobRow | null {
  for (const j of live.values()) {
    if (j.row.paper_id === paperId && j.row.kind === kind && j.key === key && (j.row.status === 'queued' || j.row.status === 'running')) return j.row;
  }
  return null;
}

/** Any queued or running job of the paper (sync leaves such papers alone until it finishes). */
export function paperHasActiveJob(paperId: string): boolean {
  for (const j of live.values()) {
    if (j.row.paper_id === paperId && (j.row.status === 'queued' || j.row.status === 'running')) return true;
  }
  return false;
}

export function activeKeyedJobs(paperId: string, kind: JobKind): { key: string; id: string }[] {
  return Array.from(live.values())
    .filter((j) => j.row.paper_id === paperId && j.row.kind === kind && j.key !== null && (j.row.status === 'queued' || j.row.status === 'running'))
    .map((j) => ({ key: j.key!, id: j.row.id }));
}

/** Start a job unless the same paper, kind and key is already queued/running. */
export function startJob(paperId: string, kind: JobKind, runner: (ctx: JobCtx) => Promise<void>, key: string | null = null): string {
  const existing = activeJob(paperId, kind, key);
  if (existing) return existing.id;

  const t = now();
  const row: JobRow = {
    id: nanoid(12),
    paper_id: paperId,
    kind,
    status: 'running',
    progress: 0,
    message: null,
    error: null,
    created_at: t,
    updated_at: t,
  };
  db.prepare('INSERT INTO jobs(id,paper_id,kind,status,progress,message,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(
    row.id,
    row.paper_id,
    row.kind,
    row.status,
    row.progress,
    row.message,
    row.error,
    row.created_at,
    row.updated_at,
  );
  const finished = Promise.withResolvers<void>();
  const job: LiveJob = { row, key, text: '', listeners: new Set(), abort: new AbortController(), finished: finished.promise };
  live.set(row.id, job);

  const ctx: JobCtx = {
    jobId: row.id,
    signal: job.abort.signal,
    progress(p, message) {
      row.progress = Math.max(0, Math.min(1, p));
      if (message !== undefined) row.message = message;
      persist(row);
      broadcast(job, { event: 'progress', data: { progress: row.progress, message: row.message } });
    },
    message(message) {
      ctx.progress(row.progress, message);
    },
    delta(text, extra) {
      job.text += text;
      broadcast(job, { event: 'delta', data: { text, ...extra } });
    },
    setText(text) {
      job.text = text;
      broadcast(job, { event: 'text', data: { text } });
    },
    emit(event, data) {
      broadcast(job, { event, data });
    },
  };

  void (async () => {
    try {
      await runner(ctx);
      if (job.abort.signal.aborted) throw new Error('취소됨');
      row.status = 'done';
      row.progress = 1;
      persist(row);
      broadcast(job, { event: 'done', data: snapshotOf(row) });
    } catch (e) {
      row.status = 'error';
      row.error = job.abort.signal.aborted ? '취소됨' : e instanceof Error ? e.message : String(e);
      persist(row);
      broadcast(job, { event: 'error', data: { message: row.error } });
      if (!job.abort.signal.aborted) console.error(`[job ${row.kind} ${row.id}]`, e);
    } finally {
      job.listeners.clear();
      setTimeout(() => live.delete(row.id), KEEP_FINISHED_MS).unref();
      finished.resolve();
    }
  })();
  return row.id;
}

export function getJobRow(id: string): JobRow | null {
  return live.get(id)?.row ?? ((db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined) || null);
}

export function cancelJob(id: string): boolean {
  const job = live.get(id);
  if (!job || (job.row.status !== 'running' && job.row.status !== 'queued')) return false;
  job.abort.abort();
  return true;
}

/** Abort active CLI work before the desktop backend exits; completed partial results stay in SQLite. */
export async function cancelAllJobs(): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const job of live.values()) {
    if (job.row.status !== 'running' && job.row.status !== 'queued') continue;
    pending.push(job.finished);
    job.abort.abort();
  }
  await Promise.all(pending);
}

/**
 * Subscribe to a job. Sends `snapshot` first; finished/unknown-in-memory jobs also get
 * a terminal `done`/`error` and `onEvent` will not be called again.
 * Returns an unsubscribe function, or null when the job does not exist.
 */
export function subscribeJob(id: string, onEvent: Listener): { unsubscribe(): void; finished: boolean } | null {
  const job = live.get(id);
  const row = job?.row ?? (db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined);
  if (!row) return null;
  onEvent({ event: 'snapshot', data: snapshotOf(row, job?.text ?? '') });
  if (!job || row.status === 'done' || row.status === 'error') {
    onEvent(row.status === 'done' ? { event: 'done', data: snapshotOf(row) } : { event: 'error', data: { message: row.error ?? '중단됨' } });
    return { unsubscribe() {}, finished: true };
  }
  job.listeners.add(onEvent);
  return { unsubscribe: () => job.listeners.delete(onEvent), finished: false };
}

/** Latest job of each kind for a paper (from the DB; live rows are persisted on every change). */
export function latestJobs(paperId: string): JobRow[] {
  return db
    .prepare(
      `SELECT * FROM jobs j WHERE paper_id=? AND created_at = (SELECT MAX(created_at) FROM jobs WHERE paper_id=j.paper_id AND kind=j.kind)
       ORDER BY created_at DESC`,
    )
    .all(paperId) as unknown as JobRow[];
}
