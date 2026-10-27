import type { JobDto } from '../types';
import { smallBtnCls } from './Dialog';

/** The user stopped the job: not a failure to show in red. */
export const isCancelled = (j: JobDto | null) => j?.status === 'error' && j.error === '취소됨';

/** Progress bar + message + 취소 for a running job; red message for a failed one; nothing once cancelled. */
export function JobBar({ job, onCancel, label }: { job: JobDto | null; onCancel(): void; label?: string }) {
  if (!job || isCancelled(job)) return null;
  if (job.status === 'error') {
    return <div className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">{job.error ?? '실패'}</div>;
  }
  if (job.status !== 'running' && job.status !== 'queued') return null;
  const pct = Math.round(job.progress * 100);
  return (
    <div className="flex items-center gap-2 text-[12px] text-fg-muted">
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-line">
        <div className="h-full bg-accent transition-[width] duration-300 ease-out" style={{ width: `${Math.max(pct, 3)}%` }} />
      </div>
      <span className="shrink-0 font-mono tabular-nums text-fg-muted">{pct}%</span>
      {(job.message || label) && <span className="max-w-[45%] shrink-0 truncate">{job.message ?? label}</span>}
      <button className={`${smallBtnCls} shrink-0`} onClick={onCancel}>
        취소
      </button>
    </div>
  );
}

export function Spinner({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 px-1 py-2 text-[13px] text-fg-muted">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
      {text}
    </div>
  );
}
