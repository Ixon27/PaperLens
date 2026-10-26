import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribeJob } from '../api';
import type { JobDto, JobKind } from '../types';
import { usePaper } from './paper';

interface Snapshot extends JobDto {
  text: string;
}

export interface JobHandle {
  job: JobDto | null;
  /** Accumulated streamed text (snapshot + deltas; `text` events replace it). */
  text: string;
  running: boolean;
  /** Follow a job that was just started (or is already running). */
  attach(jobId: string): void;
  cancel(): Promise<void>;
}

/**
 * Track the latest job of `kind` for the current paper: loads it on mount, follows it over SSE while
 * running. `onEvent` sees every event (e.g. `page`); `onFinish` runs once when the job ends.
 */
export function useJob(
  kind: JobKind,
  handlers: { onEvent?(event: string, data: unknown): void; onFinish?(job: JobDto): void } = {},
): JobHandle {
  const { paper } = usePaper();
  const [job, setJobState] = useState<JobDto | null>(null);
  const [text, setText] = useState('');
  const jobRef = useRef<JobDto | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const setJob = useCallback((j: JobDto | null) => {
    jobRef.current = j;
    setJobState(j);
  }, []);

  const attach = useCallback(
    (jobId: string) => {
      unsubRef.current?.();
      setText('');
      unsubRef.current = subscribeJob(jobId, (event, data) => {
        const cur = jobRef.current;
        if (event === 'snapshot') {
          const s = data as Snapshot;
          setJob({ id: s.id, kind: s.kind, status: s.status, progress: s.progress, message: s.message, error: s.error });
          setText(s.text ?? '');
        } else if (event === 'progress' && cur) {
          const p = data as { progress: number; message: string | null };
          setJob({ ...cur, progress: p.progress, message: p.message });
        } else if (event === 'delta') {
          const d = data as { text: string };
          setText((t) => t + d.text);
        } else if (event === 'text') {
          setText((data as { text: string }).text);
        } else if ((event === 'done' || event === 'error') && cur) {
          const finished: JobDto =
            event === 'done'
              ? { ...cur, status: 'done', progress: 1, message: (data as JobDto).message ?? cur.message }
              : { ...cur, status: 'error', error: (data as { message: string }).message };
          setJob(finished);
          handlersRef.current.onEvent?.(event, data);
          handlersRef.current.onFinish?.(finished);
          return;
        }
        handlersRef.current.onEvent?.(event, data);
      });
    },
    [setJob],
  );

  useEffect(() => {
    let cancelled = false;
    setJob(null);
    setText('');
    void api<Snapshot[]>(`/api/papers/${paper.id}/jobs`).then((list) => {
      if (cancelled) return;
      const latest = list.find((j) => j.kind === kind);
      if (!latest) return;
      if (latest.status === 'running' || latest.status === 'queued') attach(latest.id);
      else setJob({ id: latest.id, kind: latest.kind, status: latest.status, progress: latest.progress, message: latest.message, error: latest.error });
    });
    return () => {
      cancelled = true;
      unsubRef.current?.();
      unsubRef.current = null;
    };
  }, [paper.id, kind, attach, setJob]);

  const cancel = useCallback(async () => {
    if (job) await api(`/api/jobs/${job.id}/cancel`, { method: 'POST' });
  }, [job]);

  return { job, text, running: job?.status === 'running' || job?.status === 'queued', attach, cancel };
}
