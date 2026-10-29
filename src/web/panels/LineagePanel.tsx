import dagre from '@dagrejs/dagre';
import { Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MadeBy } from '../../shared/models';
import { api } from '../api';
import { primaryBtnCls, smallBtnCls } from '../components/Dialog';
import { JobBar } from '../components/JobBar';
import { Markdown } from '../components/Markdown';
import { ModelBadge } from '../components/ModelBadge';
import { reducedMotion } from '../components/motion';
import { useToast } from '../components/Toast';
import { ToggleChips } from '../figures/controls';
import { LibraryButton, useImportPaper } from '../pdf/CitationPopover';
import { usePaper } from '../state/paper';
import { useJob } from '../state/useJob';
import { useViewer } from '../state/viewer';
import type { LineageDto, LineageNodeDto, LineageRole } from '../types';
import { useGraphFullscreen } from './useGraphFullscreen';

type Response = { lineage: LineageDto | null; by: MadeBy | null; updatedAt: string | null };
type FlowNode = Node<{ work: LineageNodeDto }, 'lineage'>;
const ROLES: Record<LineageRole, { label: string; border: string }> = {
  foundation: { label: '기초 이론·개념', border: 'border-l-violet-500' },
  method: { label: '방법·도구', border: 'border-l-sky-500' },
  data: { label: '데이터·자원', border: 'border-l-teal-500' },
  prior: { label: '직접 선행 연구', border: 'border-l-amber-500' },
  contrast: { label: '비교·반박', border: 'border-l-rose-500' },
};
const roleLabels = Object.values(ROLES).map((role) => role.label);

function WorkCard({ data }: NodeProps<FlowNode>) {
  const work = data.work;
  return <div className={`h-[116px] w-[240px] rounded-md border border-line border-l-4 bg-surface p-2 shadow-sm ${work.role ? ROLES[work.role].border : 'border-l-line-strong'} ${work.side === 'paper' ? 'ring-2 ring-accent' : ''}`}>
    <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-line-strong" />
    <div className="flex items-center justify-between gap-1 text-[11px] text-fg-dim"><span>{work.year ?? '연도 미상'}</span><span className="truncate">{work.side === 'paper' ? '현재 논문' : work.role ? ROLES[work.role].label : ''}</span></div>
    <div title={work.title} className="line-clamp-3 break-words text-[13px] font-semibold leading-snug text-fg">{work.title}</div>
    <div title={work.authors} className="truncate text-[11px] text-fg-muted">{work.authors}</div>
    <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-line-strong" />
  </div>;
}
const nodeTypes = { lineage: WorkCard };

function Detail({ node }: { node: LineageNodeDto }) {
  const imp = useImportPaper(node.inLibrary);
  const meta = [node.authors, node.year, node.venue, node.citedBy === null ? null : `인용 ${node.citedBy}`].filter((v) => v !== null && v !== '');
  return <div className="rounded-lg border border-line bg-surface p-3 text-[13px]">
    <div className="font-semibold text-fg">{node.doi ? <a className="text-accent hover:underline" href={`https://doi.org/${node.doi}`} target="_blank" rel="noreferrer">{node.title}</a> : node.title}</div>
    <div className="mt-1 text-[12px] text-fg-muted">{meta.join(' · ')}</div>
    {node.role && <span className={`mt-2 inline-block border-l-4 bg-sunken px-2 py-0.5 text-[11px] ${ROLES[node.role].border}`}>{ROLES[node.role].label}</span>}
    {node.note && <div className="mt-2"><Markdown text={node.note} /></div>}
    {node.side !== 'paper' && <div className="mt-2"><LibraryButton imp={imp} doi={node.doi} label="가져오기" /></div>}
  </div>;
}

export function LineagePanel() {
  return <ReactFlowProvider><LineageInner /></ReactFlowProvider>;
}

function LineageInner() {
  const { paper } = usePaper();
  const { pdfMode, setPdfMode, tab } = useViewer();
  const { fitView } = useReactFlow();
  const toast = useToast();
  const [result, setResult] = useState<Response | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState(() => new Set(roleLabels));
  const [selected, setSelected] = useState<string | null>(null);
  const [strand, setStrand] = useState<number | null>(null);
  const graphRef = useRef<HTMLDivElement>(null);
  const { expanded, setExpanded, container, button } = useGraphFullscreen();
  useEffect(() => { if (tab !== 'lineage') setExpanded(false); }, [tab, setExpanded]);
  const load = useCallback(async () => {
    try {
      setResult(await api<Response>(`/api/papers/${paper.id}/lineage`));
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [paper.id]);
  useEffect(() => {
    setResult(null);
    setLoaded(false);
    setLoadError(null);
    setSelected(null);
    setStrand(null);
    void load();
  }, [load]);
  const job = useJob('lineage', { onFinish: (j) => { if (j.status === 'done') void load(); } });
  const lineage = result?.lineage ?? null;
  const visible = useMemo(() => lineage?.nodes.filter((n) => !n.role || active.has(ROLES[n.role].label)) ?? [], [lineage, active]);
  const highlighted = useMemo(() => {
    if (selected) {
      const ids = new Set([selected]);
      for (const edge of lineage?.edges ?? []) {
        if (edge.from === selected) ids.add(edge.to);
        if (edge.to === selected) ids.add(edge.from);
      }
      return ids;
    }
    return strand === null ? null : new Set(lineage?.strands[strand]?.ids ?? []);
  }, [lineage, selected, strand]);
  const nodes = useMemo<FlowNode[]>(() => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 110, edgesep: 24 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const work of visible) g.setNode(work.id, { width: 240, height: 116 });
    const ids = new Set(visible.map((work) => work.id));
    for (const edge of lineage?.edges ?? []) if (ids.has(edge.from) && ids.has(edge.to)) g.setEdge(edge.from, edge.to);
    dagre.layout(g);
    return visible.map((work) => {
      const point = g.node(work.id) as { x: number; y: number };
      return { id: work.id, type: 'lineage' as const, position: { x: point.x - 120, y: point.y - 58 }, data: { work }, style: { opacity: highlighted && !highlighted.has(work.id) ? 0.35 : 1 } };
    });
  }, [visible, highlighted, lineage]);
  const edges = useMemo<Edge[]>(() => {
    const ids = new Set(visible.map((n) => n.id));
    return (lineage?.edges ?? []).filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({
      id: `${e.from}->${e.to}`, source: e.from, target: e.to, type: 'smoothstep',
      animated: !reducedMotion() && selected !== null && (e.from === selected || e.to === selected),
      style: { opacity: highlighted && (!highlighted.has(e.from) || !highlighted.has(e.to)) ? 0.35 : 1 },
    }));
  }, [lineage, visible, highlighted, selected]);
  useEffect(() => {
    if (tab !== 'lineage' || !lineage || !graphRef.current) return;
    let timer: number | undefined;
    const fit = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void fitView({ padding: 0.15 }), 60);
    };
    const observer = new ResizeObserver(fit);
    observer.observe(graphRef.current);
    fit();
    return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, [tab, pdfMode, expanded, lineage, active, fitView]);
  const generate = async () => {
    if (lineage && !confirm('계보를 다시 만들까요? 기존 결과는 새로 바뀝니다.')) return;
    try {
      const { jobId } = await api<{ jobId: string }>(`/api/papers/${paper.id}/lineage`, { method: 'POST' });
      job.attach(jobId);
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  };
  const chosen = visible.find((n) => n.id === selected);
  const big = pdfMode === 'full-panel';
  return <div ref={container} role={expanded ? 'dialog' : undefined} aria-modal={expanded || undefined} aria-label={expanded ? '논문 계보 전체 화면' : undefined}
    className={expanded ? 'figure-fullscreen no-drag fixed inset-0 z-[100] flex flex-col overflow-y-auto bg-canvas text-fg' : 'flex h-full flex-col overflow-y-auto'}>
    <div className="shrink-0 border-b border-line px-3 py-2">
      {lineage && <div className="flex flex-wrap items-center gap-2">
        <button className={smallBtnCls} aria-pressed={big} onClick={() => setPdfMode(big ? 'split' : 'full-panel')}>크게 보기</button>
        <button ref={button} className={smallBtnCls} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? '닫기 (Esc)' : '전체 화면'}</button>
        <button className={smallBtnCls} disabled={job.running} onClick={() => void generate()}>다시 만들기</button>
        <span className="rounded-md bg-sunken px-2 py-1 text-[11px] text-fg-muted">{lineage.source === 'openalex' ? 'OpenAlex' : '추출한 참고문헌'}</span>
        <ModelBadge by={result?.by ?? null} />
        {result?.updatedAt && <span className="text-[11px] text-fg-dim">{result.updatedAt.slice(0, 10)}</span>}
      </div>}
      <JobBar job={job.job} onCancel={() => void job.cancel()} label="계보 생성 중…" />
    </div>
    {loadError && <div role="alert" className="p-6 text-[13px] text-danger">{loadError} <button className={smallBtnCls} onClick={() => void load()}>다시 불러오기</button></div>}
    {!loadError && !lineage && loaded && !job.running && <div className="p-6 text-[13px] text-fg-muted">
      <p>이 논문이 기대고 있는 선행 연구와 이어간 후속 연구를 실제 인용 데이터로 그립니다.</p>
      <button className={`${primaryBtnCls} mt-3`} onClick={() => void generate()}>계보 만들기</button>
    </div>}
    {lineage && <div className={`flex flex-col gap-3 p-3 ${big || expanded ? 'min-h-0 flex-1' : ''}`}>
      <div className={expanded ? 'max-h-24 shrink-0 overflow-y-auto' : ''}><Markdown text={lineage.summary} /></div>
      <div className="shrink-0"><div className="mb-1 text-[12px] text-fg-muted">선행 연구 역할</div><ToggleChips items={roleLabels} active={active} onToggle={(item) => setActive((old) => { const next = new Set(old); if (next.has(item)) next.delete(item); else next.add(item); return next; })} /></div>
      <div ref={graphRef} className={`relative w-full rounded-lg border border-line ${big || expanded ? 'min-h-[300px] flex-1' : 'h-[420px]'}`}>
        <ReactFlow colorMode="system" nodes={nodes} edges={edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} onNodeClick={(_, node) => { setSelected(node.id); setStrand(null); }} onPaneClick={() => { setSelected(null); setStrand(null); }} fitView fitViewOptions={{ padding: 0.15 }} minZoom={0.1} proOptions={{ hideAttribution: true }}>
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {lineage.strands.length > 0 && <div className="flex flex-wrap items-center gap-1"><span className="mr-1 text-[12px] text-fg-muted">연구 흐름</span>{lineage.strands.map((s, i) => <button key={`${s.label}-${i}`} className={smallBtnCls} aria-pressed={strand === i} onClick={() => { setSelected(null); setStrand((old) => old === i ? null : i); }}>{s.label}</button>)}</div>}
      {chosen && <div className={expanded ? 'max-h-48 shrink-0 overflow-y-auto' : ''}><Detail key={chosen.id} node={chosen} /></div>}
    </div>}
  </div>;
}
