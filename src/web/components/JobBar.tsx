import type { JobDto } from '../types';

/** Progress bar + message + 취소 for a running job; red message for a failed one. */
export function JobBar({ job, onCancel, label }: { job: JobDto | null; onCancel(): void; label?: string }) {
  if (!job) return null;
  if (job.status === 'error') {
    return <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{job.error ?? '실패'}</div>;
  }
  if (job.status !== 'running' && job.status !== 'queued') return null;
  const pct = Math.round(job.progress * 100);
  return (
    <div className="flex items-center gap-2 text-[12px] text-stone-600">
      <div className="h-1.5 flex-1 overflow-hidden rounded bg-stone-200">
        <div className="h-full bg-blue-500 transition-[width] duration-300" style={{ width: `${Math.max(pct, 3)}%` }} />
      </div>
      <span className="shrink-0 tabular-nums">{pct}%</span>
      {(job.message || label) && <span className="max-w-[45%] shrink-0 truncate">{job.message ?? label}</span>}
      <button className="shrink-0 rounded border border-stone-300 px-2 py-0.5 hover:bg-stone-100" onClick={onCancel}>
        취소
      </button>
    </div>
  );
}
