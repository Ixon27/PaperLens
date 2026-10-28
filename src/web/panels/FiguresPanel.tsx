import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { anchorId, anchorOf, captionLabel, type ExplainAnchor } from '../../shared/explain';
import { FIGURE_KIND_GROUPS, FIGURE_KIND_LABELS, type FigureKind, type FigureSpec } from '../../shared/figure-spec';
import type { MadeBy } from '../../shared/models';
import { api, subscribeJob } from '../api';
import { primaryBtnCls, smallBtnCls } from '../components/Dialog';
import { JobBar, Spinner } from '../components/JobBar';
import { PageChip } from '../components/Markdown';
import { ModelBadge } from '../components/ModelBadge';
import { reducedMotion } from '../components/motion';
import { useToast } from '../components/Toast';
import { FigureWidget } from '../figures/FigureWidget';
import { renderPageImage } from '../pdf/pageImage';
import { usePaper } from '../state/paper';
import { useViewer } from '../state/viewer';
import type { BlockDto, JobDto } from '../types';

type Item = { anchor: string; spec: FigureSpec; imageUrl: string | null; by: MadeBy | null; updatedAt: string };
type Marker = { id: string; anchor: ExplainAnchor; block: BlockDto };
type Response = { items: Item[]; running: { anchor: string; jobId: string }[] };

export function FiguresPanel() {
  const { paper, blocks } = usePaper();
  const { utilsRef, scrollToBlock, jumpToPage, pdfMode, setPdfMode, figureFocus, takeFigureFocus } = useViewer();
  const toast = useToast();
  const [items, setItems] = useState<Item[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, JobDto>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, FigureKind | 'auto'>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState<Set<string>>(new Set());
  const subscriptions = useRef(new Map<string, { id: string; close: () => void }>());
  const startingRef = useRef(new Set<string>());
  const generation = useRef(0);
  const cards = useRef(new Map<string, HTMLDivElement>());
  const markers = useMemo(() => {
    const result: Marker[] = [];
    if (!blocks) return result;
    blocks.forEach((block, i) => {
      const anchor = anchorOf(blocks, i);
      if (anchor && anchor.type !== 'section') result.push({ id: anchorId(anchor), anchor, block });
    });
    return result;
  }, [blocks]);

  const loadRef = useRef<() => Promise<void>>(async () => {});
  const attach = useCallback((anchor: string, jobId: string) => {
    const previous = subscriptions.current.get(anchor);
    if (previous?.id === jobId) return;
    previous?.close();
    setJobs((old) => ({ ...old, [anchor]: { id: jobId, kind: 'figure', status: 'queued', progress: 0, message: null, error: null } }));
    const close = subscribeJob(jobId, (event, data) => {
      if (subscriptions.current.get(anchor)?.id !== jobId) return;
      if (event === 'snapshot' || event === 'progress') {
        const value = data as Partial<JobDto>;
        setJobs((old) => old[anchor]?.id === jobId ? { ...old, [anchor]: { ...old[anchor], ...value, id: jobId, kind: 'figure' } } : old);
      } else if (event === 'done' || event === 'error') {
        subscriptions.current.delete(anchor);
        setJobs((old) => { const next = { ...old }; if (next[anchor]?.id === jobId) delete next[anchor]; return next; });
        if (event === 'error') {
          const message = data && typeof data === 'object' && 'message' in data && typeof data.message === 'string'
            ? data.message : '그림 위젯을 만들지 못했습니다';
          if (message !== '취소됨') setErrors((old) => ({ ...old, [anchor]: message }));
        }
        void loadRef.current();
      }
    });
    subscriptions.current.set(anchor, { id: jobId, close });
  }, []);
  const load = useCallback(async () => {
    const current = generation.current;
    try {
      const result = await api<Response>(`/api/papers/${paper.id}/figures`);
      if (current !== generation.current) return;
      setLoadError(null);
      setItems(result.items);
      result.running.forEach(({ anchor, jobId }) => attach(anchor, jobId));
    } catch (error) {
      if (current === generation.current) setLoadError((error as Error).message);
    }
  }, [paper.id, attach]);
  loadRef.current = load;

  useEffect(() => {
    generation.current++;
    setItems(null); setLoadError(null); setJobs({}); setErrors({}); setSelected({}); setExpanded(new Set()); setStarting(new Set());
    startingRef.current.clear();
    void load();
    return () => {
      generation.current++;
      subscriptions.current.forEach(({ close }) => close());
      subscriptions.current.clear();
    };
  }, [paper.id, load]);

  const start = useCallback(async (marker: Marker, kind: FigureKind | 'auto') => {
    if (startingRef.current.has(marker.id) || subscriptions.current.has(marker.id)) return;
    startingRef.current.add(marker.id);
    setStarting(new Set(startingRef.current));
    setErrors((old) => { const next = { ...old }; delete next[marker.id]; return next; });
    const current = generation.current;
    try {
      const viewer = utilsRef.current?.getViewer();
      const imageDataUrl = viewer ? await renderPageImage(viewer, marker.anchor.page) : null;
      if (current !== generation.current) return;
      if (!imageDataUrl) { toast('쪽 이미지를 만들지 못했습니다', { tone: 'error' }); return; }
      const result = await api<{ jobId: string }>(`/api/papers/${paper.id}/figures`, { method: 'POST', json: { anchor: marker.anchor, imageDataUrl, kind: kind === 'auto' ? null : kind } });
      if (current === generation.current) attach(marker.id, result.jobId);
    } catch (error) {
      if (current === generation.current) setErrors((old) => ({ ...old, [marker.id]: (error as Error).message }));
    } finally {
      if (current === generation.current) { startingRef.current.delete(marker.id); setStarting(new Set(startingRef.current)); }
    }
  }, [paper.id, utilsRef, toast, attach]);

  useEffect(() => {
    if (!figureFocus || !items || !blocks) return;
    const marker = markers.find((m) => m.id === figureFocus.anchor);
    if (!marker) return;
    takeFigureFocus(figureFocus.nonce);
    cards.current.get(marker.id)?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    if (figureFocus.autoStart && !items.some((item) => item.anchor === marker.id) && !subscriptions.current.has(marker.id)) void start(marker, 'auto');
  }, [figureFocus, items, blocks, markers, start, takeFigureFocus]);

  const big = pdfMode === 'full-panel';
  return <div className="h-full overflow-y-auto p-4">
    <div className="mb-3 flex items-center gap-2"><h2 className="flex-1 font-semibold text-fg">그림·표 {markers.length}개</h2><button className={smallBtnCls} aria-pressed={big} onClick={() => setPdfMode(big ? 'split' : 'full-panel')}>크게 보기</button></div>
    <p className="mb-4 text-[13px] text-fg-muted">그림마다 AI가 맞는 위젯을 골라 만지며 볼 수 있게 바꿉니다. 그림에서 읽은 값은 근사값으로 표시합니다.</p>
    {loadError ? <div role="alert" className="text-sm text-danger">{loadError} <button className={smallBtnCls} onClick={() => void load()}>다시 불러오기</button></div>
      : !items || !blocks ? <Spinner text="불러오는 중…" />
      : markers.length === 0 ? <p className="text-[13px] text-fg-muted">인식된 그림·표 캡션이 없습니다. PDF에서 번호가 있는 그림·표 캡션이 추출되어야 위젯을 만들 수 있습니다.</p>
      : <div className="flex flex-col gap-3">{markers.map((marker) => {
      const item = items.find((entry) => entry.anchor === marker.id);
      const job = jobs[marker.id];
      const kind = selected[marker.id] ?? 'auto';
      const open = expanded.has(marker.id);
      return <div key={marker.id} data-anchor={marker.id} ref={(node) => { if (node) cards.current.set(marker.id, node); else cards.current.delete(marker.id); }} className="rounded-xl border border-line bg-surface p-3">
        <div className="flex items-center gap-2"><strong className="flex-1 text-sm text-fg">{captionLabel(marker.block.text)?.label}</strong><PageChip page={marker.anchor.page} onJump={jumpToPage} /></div>
        <button type="button" aria-expanded={open} className={`mt-2 w-full text-left text-[13px] text-fg-muted ${open ? '' : 'line-clamp-2'}`} onClick={() => setExpanded((old) => { const next = new Set(old); if (next.has(marker.id)) next.delete(marker.id); else next.add(marker.id); return next; })}>{marker.block.text}</button>
        <div className="my-3 flex flex-wrap items-center gap-2">
          <select aria-label={`${captionLabel(marker.block.text)?.label ?? '그림'} 위젯 종류`} className="rounded-lg border border-line bg-surface px-2 py-1 text-sm text-fg" value={kind} disabled={!!job || starting.has(marker.id)} onChange={(e) => setSelected((old) => ({ ...old, [marker.id]: e.target.value as FigureKind | 'auto' }))}><option value="auto">자동</option>{FIGURE_KIND_GROUPS.map((group) => <optgroup key={group.label} label={group.label}>{group.kinds.map((k) => <option key={k} value={k}>{FIGURE_KIND_LABELS[k]}</option>)}</optgroup>)}</select>
          <button className={primaryBtnCls} disabled={!!job || starting.has(marker.id)} onClick={() => void start(marker, kind)}>{item ? '다시 만들기' : '인터랙티브로 만들기'}</button>
          <button className={smallBtnCls} onClick={() => scrollToBlock(marker.block)}>원본 보기</button>
        </div>
        {starting.has(marker.id) && <Spinner text="쪽 이미지 만드는 중…" />}
        {job && <JobBar job={job} onCancel={() => void api(`/api/jobs/${job.id}/cancel`, { method: 'POST' }).catch((error: Error) => toast(error.message, { tone: 'error' }))} />}
        {errors[marker.id] && <p role="alert" className="my-2 text-sm text-danger">{errors[marker.id]}</p>}
        {item && <><FigureWidget spec={item.spec} imageUrl={item.imageUrl} /><div className="mt-2 flex items-center gap-2 text-xs text-fg-dim"><ModelBadge by={item.by} /><span>{item.updatedAt.slice(0, 10)}</span></div></>}
      </div>;
    })}</div>}
  </div>;
}
