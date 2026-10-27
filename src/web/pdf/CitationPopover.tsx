import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { api, subscribeJob } from '../api';
import { smallBtnCls } from '../components/Dialog';
import type { CiteHit } from './citation';

export interface RefEntryDto {
  key: string;
  authors: string | null;
  year: number | null;
  title: string | null;
  journal: string | null;
  doi: string | null;
  inLibrary: string | null;
}

export interface WorkSummaryDto {
  openalexId: string;
  doi: string | null;
  title: string;
  year: number | null;
  venue: string | null;
  citedBy: number;
  abstract: string | null;
  oaPdf: string | null;
  authors: string[];
  inLibrary: string | null;
}

type CitationResponse = { status: 'pending'; jobId: string } | { status: 'ok'; entries: RefEntryDto[] };

interface ImportResult {
  paperId: string;
  jobId?: string;
  duplicate?: boolean;
}

export interface ImportState {
  /** Library paper id once imported (or already present). */
  libId: string | null;
  /** 0–1 while the import job runs, else null. */
  progress: number | null;
  busy: boolean;
  error: string | null;
  start(doi: string): Promise<void>;
}

/** `POST /api/papers/import` for a DOI, following the import job's progress inline. */
export function useImportPaper(initialLibId: string | null): ImportState {
  const [libId, setLibId] = useState(initialLibId);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => setLibId(initialLibId), [initialLibId]);
  useEffect(() => () => unsubRef.current?.(), []);

  const start = useCallback(async (doi: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<ImportResult>('/api/papers/import', { method: 'POST', json: { input: doi } });
      setLibId(r.paperId);
      if (r.jobId) {
        setProgress(0);
        unsubRef.current?.();
        unsubRef.current = subscribeJob(r.jobId, (event, data) => {
          if (event === 'snapshot' || event === 'progress') setProgress((data as { progress: number }).progress);
          else if (event === 'done') setProgress(null);
          else if (event === 'error') {
            setProgress(null);
            setError((data as { message?: string }).message ?? '가져오기 실패');
          }
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return { libId, progress, busy, error, start };
}

/** `smallBtnCls` with accent text, for links that leave the current view. */
const accentLinkBtn =
  'inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-line-strong bg-surface px-2 text-[12px] text-accent transition-[transform,background-color] duration-150 ease-out hover:bg-hover active:scale-[0.97]';

/** `가져오기` / progress / `열기` controls shared by reference cards and related-paper rows. */
export function LibraryButton({ imp, doi, label, onNeedDoi }: { imp: ImportState; doi: string | null; label: string; onNeedDoi?: () => Promise<string | null> }) {
  const [noDoi, setNoDoi] = useState(false);
  if (imp.libId) {
    return (
      <span className="inline-flex items-center gap-1.5">
        {imp.progress !== null && <span className="text-[11px] tabular-nums text-fg-muted">가져오는 중 {Math.round(imp.progress * 100)}%</span>}
        <Link href={`/paper/${imp.libId}`} className={accentLinkBtn}>
          열기
        </Link>
      </span>
    );
  }
  const disabled = imp.busy || noDoi || (!doi && !onNeedDoi);
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        className={smallBtnCls}
        disabled={disabled}
        onClick={async () => {
          const d = doi ?? (onNeedDoi ? await onNeedDoi() : null);
          if (!d) {
            setNoDoi(true);
            return;
          }
          await imp.start(d);
        }}
      >
        {noDoi || (!doi && !onNeedDoi) ? 'DOI 없음' : imp.busy ? '가져오는 중…' : label}
      </button>
      {imp.error && <span className="text-[11px] text-danger">{imp.error}</span>}
    </span>
  );
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

/** One reference entry with 요약 보기 / 라이브러리에 추가 / 원문 페이지. */
export function RefCard({ entry }: { entry: RefEntryDto }) {
  const [summary, setSummary] = useState<WorkSummaryDto | null>(null);
  const [lookupState, setLookupState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [lookupError, setLookupError] = useState('');
  const [showSummary, setShowSummary] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const imp = useImportPaper(entry.inLibrary);
  const canLookup = Boolean(entry.doi || entry.title);

  const lookup = useCallback(async (): Promise<WorkSummaryDto | null> => {
    if (summary) return summary;
    const q = entry.doi ? `doi=${encodeURIComponent(entry.doi)}` : `title=${encodeURIComponent(entry.title ?? '')}`;
    setLookupState('loading');
    try {
      const s = await api<WorkSummaryDto>(`/api/openalex/lookup?${q}`);
      setSummary(s);
      setLookupState('idle');
      return s;
    } catch (e) {
      setLookupState('error');
      setLookupError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [entry.doi, entry.title, summary]);

  const libId = imp.libId ?? summary?.inLibrary ?? null;
  const doi = entry.doi ?? summary?.doi ?? null;
  const impShown: ImportState = libId === imp.libId ? imp : { ...imp, libId };

  return (
    <div className="rounded-lg border border-line bg-surface p-2.5 text-[12.5px] leading-snug">
      <div className="font-semibold text-fg">
        <span className="mr-1 font-normal text-fg-dim">[{entry.key}]</span>
        {entry.title ?? '(제목 없음)'}
      </div>
      <div className="mt-0.5 text-fg-muted">
        {entry.authors && <span>{cut(entry.authors, 120)}</span>}
        {entry.year !== null && <span> · {entry.year}</span>}
        {entry.journal && <span className="italic"> · {entry.journal}</span>}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <button
          className={smallBtnCls}
          disabled={!canLookup || lookupState === 'loading'}
          onClick={async () => {
            if (showSummary) {
              setShowSummary(false);
              return;
            }
            setShowSummary(true);
            await lookup();
          }}
        >
          {showSummary ? '요약 닫기' : '요약 보기'}
        </button>
        <LibraryButton
          imp={impShown}
          doi={doi}
          label="라이브러리에 추가"
          onNeedDoi={entry.title ? async () => (await lookup())?.doi ?? null : undefined}
        />
        {doi && (
          <a className={accentLinkBtn} href={`https://doi.org/${doi}`} target="_blank" rel="noreferrer">
            원문 페이지
          </a>
        )}
      </div>
      {showSummary && (
        <div className="mt-2 rounded-md bg-sunken p-2 text-[12px] text-fg">
          {lookupState === 'loading' && <span className="text-fg-muted">논문 정보를 불러오는 중…</span>}
          {lookupState === 'error' && <span className="text-danger">{lookupError}</span>}
          {summary && (
            <>
              <div className="text-fg-muted">
                {[summary.venue, summary.year, `인용 ${summary.citedBy}회`].filter((x) => x !== null && x !== '').join(' · ')}
              </div>
              {summary.abstract ? (
                <p className="mt-1 whitespace-pre-wrap">
                  {expanded || summary.abstract.length <= 600 ? summary.abstract : summary.abstract.slice(0, 600) + '…'}
                  {summary.abstract.length > 600 && (
                    <button className="ml-1 text-accent hover:underline" onClick={() => setExpanded((x) => !x)}>
                      {expanded ? '접기' : '더 보기'}
                    </button>
                  )}
                </p>
              ) : (
                <p className="mt-1 text-fg-dim">초록 없음</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function hitQuery(hit: CiteHit): string {
  return hit.kind === 'numeric'
    ? `keys=${encodeURIComponent(hit.keys.join(','))}`
    : `family=${encodeURIComponent(hit.family)}&year=${encodeURIComponent(hit.year)}`;
}

/** Offsets inside the PDF pane; `bottom` places the popover above the click. */
export interface PopoverPos {
  left: number;
  top?: number;
  bottom?: number;
}

/** Popover for a clicked in-text citation, absolutely positioned inside the PDF pane. */
export function CitationPopover({ paperId, hit, pos, onClose }: { paperId: string; hit: CiteHit; pos: PopoverPos; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'pending' } | { kind: 'ok'; entries: RefEntryDto[] } | { kind: 'error'; message: string }>({
    kind: 'loading',
  });
  const query = hitQuery(hit);

  useEffect(() => {
    let alive = true;
    let unsub: (() => void) | null = null;
    const load = async () => {
      try {
        const r = await api<CitationResponse>(`/api/papers/${paperId}/citation?${query}`);
        if (!alive) return;
        if (r.status === 'ok') {
          setState({ kind: 'ok', entries: r.entries });
          return;
        }
        setState({ kind: 'pending' });
        unsub = subscribeJob(r.jobId, (event, data) => {
          if (!alive) return;
          if (event === 'done') void load();
          else if (event === 'error') setState({ kind: 'error', message: (data as { message?: string }).message ?? '참고문헌 추출 실패' });
        });
      } catch (e) {
        if (alive) setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    };
    void load();
    return () => {
      alive = false;
      unsub?.();
    };
  }, [paperId, query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const label = hit.kind === 'numeric' ? `[${hit.keys.join(',')}]` : `${hit.family} ${hit.year}`;

  return (
    <div
      ref={ref}
      className="pr-tip absolute z-50 max-h-[60%] w-max min-w-[260px] max-w-[420px] overflow-y-auto rounded-xl border border-line bg-raised p-2 shadow-pop"
      style={pos}
      onClick={(e) => e.stopPropagation()}
    >
      {state.kind === 'loading' && <div className="p-2 text-[12.5px] text-fg-muted">불러오는 중…</div>}
      {state.kind === 'pending' && <div className="p-2 text-[12.5px] text-fg-muted">참고문헌 목록 추출 중…</div>}
      {state.kind === 'error' && <div className="p-2 text-[12.5px] text-danger">{state.message}</div>}
      {state.kind === 'ok' && !state.entries.length && (
        <div className="p-2 text-[12.5px] text-fg-muted">참고문헌에서 {label}를 찾지 못했습니다</div>
      )}
      {state.kind === 'ok' && state.entries.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {state.entries.map((e) => (
            <RefCard key={e.key} entry={e} />
          ))}
        </div>
      )}
    </div>
  );
}
