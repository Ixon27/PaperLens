import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { COMPARISON_LABELS, comparisonSourceHref, locateComparisonSource, type ComparisonClaim, type ComparisonResult } from '../../shared/comparison';
import { parsePageHref } from '../../shared/cite';
import { api, subscribeJob } from '../api';
import { usePaper } from '../state/paper';
import { useViewer } from '../state/viewer';
import { AiUsageNotice } from './AiUsageNotice';
import { Dialog, primaryBtnCls, smallBtnCls } from './Dialog';
import { ModelBadge } from './ModelBadge';

export interface ComparisonDialogProps { paperIds?: string[]; onClose(): void }
interface PendingComparison { jobId: string; comparisonId: string }

/** Also usable with no selected IDs: a library browser for all saved comparison results. */
export function ComparisonDialog({ paperIds = [], onClose }: ComparisonDialogProps) {
  const [saved, setSaved] = useState<ComparisonResult[]>([]);
  const [selected, setSelected] = useState<ComparisonResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingComparison | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const unsubscribe = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  const selectionKey = `pr.comparison.${[...paperIds].sort().join(',')}`;
  const validSelection = paperIds.length >= 2 && paperIds.length <= 4 && new Set(paperIds).size === paperIds.length;
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api<{ comparisons: ComparisonResult[] }>('/api/comparisons');
      if (mounted.current) setSaved(response.comparisons);
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { if (mounted.current) setLoading(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => { mounted.current = false; unsubscribe.current?.(); };
  }, [reload]);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(selectionKey);
      if (raw) {
        const job = JSON.parse(raw) as PendingComparison;
        if (typeof job.jobId === 'string' && typeof job.comparisonId === 'string') setPending(job);
      }
    } catch { /* Browser storage is optional, server persistence is not. */ }
  }, [selectionKey]);
  useEffect(() => {
    if (!pending) return;
    let active = true;
    const cleanup = subscribeJob(pending.jobId, (event, data) => {
      if (!mounted.current) return;
      const value = data as { progress?: number; message?: string; error?: string; status?: string };
      if (event === 'snapshot' || event === 'progress') {
        if (typeof value.progress === 'number') setProgress(value.progress);
        setMessage(value.message ?? 'PDF 원문 비교 중…');
      }
      if (event === 'done' || event === 'error') {
        setPending(null);
        setCancelling(false);
        try { sessionStorage.removeItem(selectionKey); } catch { /* Optional resume state. */ }
        if (event === 'error') setError(value.message ?? value.error ?? '비교를 완료하지 못했습니다');
        else {
          void api<{ comparison: ComparisonResult }>(`/api/comparisons/${encodeURIComponent(pending.comparisonId)}`).then((response) => {
            if (mounted.current) setSelected(response.comparison);
          }).catch((e: Error) => { if (mounted.current) setError(e.message); });
          void reload();
        }
      }
    });
    // A stale resumed job may have been removed; SSE alone cannot surface an HTTP 404 body.
    void api(`/api/jobs/${encodeURIComponent(pending.jobId)}`).catch((e: Error) => {
      if (!active || !mounted.current) return;
      setPending(null);
      setError(e.message);
      try { sessionStorage.removeItem(selectionKey); } catch { /* Optional resume state. */ }
    });
    const stop = () => { active = false; cleanup(); };
    unsubscribe.current = stop;
    return stop;
  }, [pending, reload, selectionKey]);
  const generate = async () => {
    setStarting(true);
    setError(null);
    setProgress(0);
    try {
      const job = await api<PendingComparison>('/api/comparisons', { method: 'POST', json: { paperIds } });
      if (!mounted.current) return;
      setPending(job);
      try { sessionStorage.setItem(selectionKey, JSON.stringify(job)); } catch { /* Optional resume state. */ }
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { if (mounted.current) setStarting(false); }
  };
  const cancel = async () => {
    if (!pending) return;
    setCancelling(true);
    try { await api(`/api/jobs/${encodeURIComponent(pending.jobId)}/cancel`, { method: 'POST' }); }
    catch (e) { setError((e as Error).message); setCancelling(false); }
  };
  const renderClaim = (claim: ComparisonClaim) => <>
    {claim.unavailable && <span className="mr-1 text-[12px] font-medium text-fg-muted">발췌에서 확인 불가</span>}
    <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{claim.text}</p>
    {claim.sources.map((source, i) => <details key={i} className="mt-2 rounded-lg border border-line px-2 py-1 text-[12px]">
      <summary className="cursor-pointer text-accent">{selected?.papers.find((p) => p.id === source.paperId)?.title ?? source.paperId} · p.{source.page}</summary>
      <blockquote className="my-2 whitespace-pre-wrap border-l-2 border-accent/30 pl-2 text-fg-muted">“{source.quote}”</blockquote>
      <Link href={comparisonSourceHref(source)} className="text-accent underline" onClick={onClose}>PDF 원문과 하이라이트 열기</Link>
    </details>)}
  </>;
  return <Dialog title="논문 비교" width={1120} onClose={onClose}>
    <div className="space-y-4 text-fg">
      <p className="text-[13px] text-fg-muted">2~4개 논문의 연구 질문·방법·데이터·결과·한계를 PDF 원문으로 비교합니다. 저장 결과는 선택한 논문들과 함께 동기화됩니다.</p>
      {paperIds.length > 0 && <div className="space-y-2 rounded-xl border border-line p-3">
        <AiUsageNotice profile="heavy" requests={1} detail="선택한 PDF의 제한된 원문 발췌를 한 번 요청합니다. 인용 검증 실패 시 자동 재요청하지 않습니다." />
        {!validSelection && <p role="alert" className="text-[13px] text-danger">중복 없이 논문 2~4개를 선택하세요.</p>}
        <button className={primaryBtnCls} disabled={!validSelection || starting || !!pending} onClick={() => void generate()}>{starting ? '요청 중…' : error ? '비교 다시 시도' : `${paperIds.length}개 논문 새 비교`}</button>
      </div>}
      {pending && <div role="status" className="space-y-2 rounded-xl border border-line p-3">
        <p className="text-[13px]">{message || '비교 시작 중…'} · {Math.round(progress * 100)}%</p>
        <progress className="h-2 w-full accent-accent" max={1} value={progress} aria-label="논문 비교 진행률" />
        <button className={smallBtnCls} disabled={cancelling} onClick={() => void cancel()}>{cancelling ? '취소 중…' : '비교 취소'}</button>
        <p className="text-[12px] text-fg-muted">창을 닫아도 작업은 계속됩니다. 취소하려면 위 버튼을 사용하세요.</p>
      </div>}
      {error && <div role="alert" className="rounded-lg bg-danger-soft p-3 text-[13px] text-danger">{error}</div>}
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold">저장된 비교 ({saved.length})</h3>
        <button className={smallBtnCls} disabled={loading} onClick={() => { setError(null); void reload(); }}>새로 고침</button>
        {loading && <span role="status" className="text-[12px] text-fg-muted">불러오는 중…</span>}
      </div>
      {!loading && !saved.length && <p className="text-[13px] text-fg-muted">저장된 비교가 없습니다. 라이브러리에서 논문 2~4개를 선택해 비교하세요.</p>}
      <div className="max-h-44 space-y-1 overflow-y-auto">
        {saved.map((result) => <button key={result.id} aria-pressed={selected?.id === result.id} className={`block w-full rounded-lg border p-2 text-left text-[13px] ${selected?.id === result.id ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover'}`} onClick={() => setSelected(result)}>
          <span className="block font-medium">{result.papers.map((p) => p.title).join(' ↔ ')}</span>
          <span className="text-[12px] text-fg-muted">{new Date(result.createdAt).toLocaleString()}</span>
        </button>)}
      </div>
      {selected && <article className="space-y-4 border-t border-line pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-[15px] font-semibold">비교 결과</h3>
          <ModelBadge by={selected.by} />
          <a className={smallBtnCls} href={`/api/comparisons/${encodeURIComponent(selected.id)}/markdown`} download>Markdown 다운로드</a>
        </div>
        <p className="text-[12px] leading-relaxed text-fg-muted">PDF 원문 발췌에 근거한 AI 비교입니다. 확인 불가는 제공된 발췌의 범위이며 논문 전체에 없다는 뜻이 아닙니다. 수치는 연결된 원문에서 확인하세요. {selected.papers.map((p) => `${p.title}: ${p.sampledBlocks}/${p.totalBlocks} 본문 블록`).join(' · ')}</p>
        {selected.sections.map((section) => <section key={section.dimension} className="space-y-3">
          <h4 className="text-[14px] font-semibold">{COMPARISON_LABELS[section.dimension]}</h4>
          <div className="grid gap-3 md:grid-cols-2">
            {section.papers.map((cell) => <div key={cell.paperId} className="min-w-0 rounded-xl border border-line p-3">
              <h5 className="mb-2 text-[13px] font-semibold">{selected.papers.find((p) => p.id === cell.paperId)?.title}</h5>
              {renderClaim(cell.claim)}
            </div>)}
          </div>
          <div className="rounded-xl bg-sunken p-3"><h5 className="mb-2 text-[13px] font-semibold">공통점과 차이점</h5>{renderClaim(section.synthesis)}</div>
        </section>)}
      </article>}
    </div>
  </Dialog>;
}

/** Mount inside the workspace providers to consume paper-specific PDF quote deep links. */
export function ComparisonSourceNavigation() {
  const { paper, blocks } = usePaper();
  const { numPages, jumpToPage, revealSource, scrollToBlock } = useViewer();
  const [hash, setHash] = useState(() => window.location.hash);
  const navigated = useRef('');
  useEffect(() => {
    const changed = () => setHash(window.location.hash);
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  useEffect(() => {
    const key = `${paper.id}${hash}`;
    if (!blocks || !numPages || navigated.current === key) return;
    const source = parsePageHref(hash);
    if (!source || source.page < 1 || source.page > numPages) return;
    navigated.current = key;
    if (source.quote) {
      try {
        const hit = locateComparisonSource({ paperId: paper.id, page: source.page, quote: source.quote }, [{ id: paper.id, blocks }]);
        const block = blocks.find((b) => b.idx === hit.blockIdx);
        if (block) {
          if (block.spans.length) revealSource(block, hit.start, hit.end);
          else scrollToBlock(block);
          return;
        }
      } catch { /* A changed/missing PDF must not fabricate a source highlight. */ }
    }
    jumpToPage(source.page);
  }, [paper.id, blocks, numPages, hash, jumpToPage, revealSource, scrollToBlock]);
  return null;
}
