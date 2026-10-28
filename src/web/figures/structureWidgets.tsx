import dagre from '@dagrejs/dagre';
import { MarkerType, Panel, ReactFlow, useReactFlow, useStore, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationNodeDatum, type SimulationLinkDatum } from 'd3-force';
import { useEffect, useMemo, useState } from 'react';
import type { FigureSpec, FigureTreeNode } from '../../shared/figure-spec';
import { smallBtnCls } from '../components/Dialog';
import { PageChip } from '../components/Markdown';
import { useViewer } from '../state/viewer';
import { ToggleChips } from './controls';
import { useCloseFigure, useFigureExpanded } from './FigureDisplayContext';

type Spec<K extends FigureSpec['kind']> = Extract<FigureSpec, { kind: K }>;

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  return reduced;
}
function FlowControls() {
  const { zoomIn, zoomOut, fitView, getViewport, setViewport } = useReactFlow();
  const pan = (dx: number, dy: number) => {
    const viewport = getViewport();
    void setViewport({ ...viewport, x: viewport.x + dx, y: viewport.y + dy });
  };
  return <Panel position="top-right" className="flex max-w-[240px] flex-wrap gap-1 rounded-lg bg-surface p-1">
    <button type="button" className={smallBtnCls} onClick={() => void zoomIn()}>확대</button>
    <button type="button" className={smallBtnCls} onClick={() => void zoomOut()}>축소</button>
    <button type="button" className={smallBtnCls} onClick={() => void fitView({ padding: 0.15, maxZoom: 1 })}>전체 보기</button>
    <button type="button" className={smallBtnCls} aria-label="왼쪽으로 이동" onClick={() => pan(100, 0)}>←</button>
    <button type="button" className={smallBtnCls} aria-label="위로 이동" onClick={() => pan(0, 100)}>↑</button>
    <button type="button" className={smallBtnCls} aria-label="아래로 이동" onClick={() => pan(0, -100)}>↓</button>
    <button type="button" className={smallBtnCls} aria-label="오른쪽으로 이동" onClick={() => pan(-100, 0)}>→</button>
  </Panel>;
}

function FlowSelection({ id }: { id: string }) {
  const { getNode, getViewport, setCenter, viewportInitialized } = useReactFlow();
  const width = useStore(state => state.width);
  const height = useStore(state => state.height);
  useEffect(() => {
    if (!viewportInitialized || !width || !height) return;
    const node = getNode(id);
    if (!node) return;
    void setCenter(
      node.position.x + (node.measured?.width ?? 200) / 2,
      node.position.y + (node.measured?.height ?? (Number(node.style?.minHeight) || 56)) / 2,
      { zoom: getViewport().zoom },
    );
  }, [id, viewportInitialized, width, height, getNode, getViewport, setCenter]);
  return null;
}

export function FlowWidget({ spec }: { spec: Spec<'flow'> }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const reduced = useReducedMotion();
  const expanded = useFigureExpanded();
  const closeFigure = useCloseFigure();
  const { jumpToPage } = useViewer();
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setIndex(i => {
      if (i >= spec.steps.length - 1) { setPlaying(false); return i; }
      return i + 1;
    }), 2500);
    return () => window.clearInterval(timer);
  }, [playing, spec.steps.length]);
  const positions = useMemo(() => {
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: 'TB', nodesep: 50, ranksep: 80, marginx: 30, marginy: 30 });
    graph.setDefaultEdgeLabel(() => ({}));
    spec.steps.forEach(s => graph.setNode(s.id, { width: 200, height: Math.max(56, Math.ceil(s.label.length / 18) * 20 + 24) }));
    spec.edges.forEach(e => graph.setEdge(e.from, e.to));
    dagre.layout(graph);
    return new Map(spec.steps.map(s => {
      const p = graph.node(s.id) as { x: number; y: number; height: number };
      return [s.id, { x: p.x - 100, y: p.y - p.height / 2 }];
    }));
  }, [spec]);
  const nodes: Node[] = spec.steps.map((s, i) => ({ id: s.id, position: positions.get(s.id)!, data: { label: s.label }, style: { width: 200, minHeight: Math.max(56, Math.ceil(s.label.length / 18) * 20 + 24), whiteSpace: 'normal', overflowWrap: 'anywhere', background: 'var(--pr-surface)', color: 'var(--pr-fg)', border: `2px solid ${i === index ? 'var(--pr-accent)' : 'var(--pr-line)'}` } }));
  const edges: Edge[] = spec.edges.map((e, i) => ({ id: String(i), source: e.from, target: e.to, type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--pr-fg-dim)' }, style: { stroke: 'var(--pr-fg-dim)' }, animated: !reduced && e.to === spec.steps[index].id }));
  const step = spec.steps[index];
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={smallBtnCls} disabled={index === 0} onClick={() => setIndex(i => i - 1)}>이전</button>
      <button type="button" className={smallBtnCls} disabled={index === spec.steps.length - 1} onClick={() => setIndex(i => i + 1)}>다음</button>
      <button type="button" className={smallBtnCls} onClick={() => { if (!playing && index === spec.steps.length - 1) setIndex(0); setPlaying(!playing); }}>{playing ? '일시정지' : '자동 재생'}</button>
      <span aria-live="polite">{index + 1}/{spec.steps.length}</span>
    </div>
    <p className="text-xs text-fg-dim">드래그하여 이동하고 확대·축소할 수 있습니다. 화살표의 설명은 아래 관계 목록에서 확인하세요.</p>
    <div className="overflow-hidden rounded-lg border border-line" style={{ height: expanded ? 'min(70vh, 800px)' : 400 }}>
      <ReactFlow nodes={nodes} edges={edges} defaultViewport={{ x: 20, y: 20, zoom: 1 }} minZoom={0.1} maxZoom={2} nodesDraggable={false} nodesConnectable={false} onNodeClick={(_, node) => setIndex(spec.steps.findIndex(s => s.id === node.id))}>
        <FlowControls />
        <FlowSelection id={step.id} />
      </ReactFlow>
    </div>
    <div className="rounded-lg bg-raised p-3"><strong>{step.label}</strong>{step.page && <PageChip page={step.page} onJump={page => { closeFigure(); jumpToPage(page); }} />}<p className="mt-1 text-sm text-fg-dim">{step.detail}</p></div>
    <div className="flex flex-wrap gap-1" aria-label="단계 선택">{spec.steps.map((s, i) => <button key={s.id} type="button" className={smallBtnCls} aria-pressed={index === i} onClick={() => setIndex(i)}>{s.label}</button>)}</div>
    <section aria-label="단계 간 관계" className="space-y-2">
      <h4 className="text-sm font-semibold">단계 간 관계</h4>
      <ol className="space-y-1 text-sm">{spec.edges.map((edge, i) => {
        const from = spec.steps.findIndex(s => s.id === edge.from);
        const to = spec.steps.findIndex(s => s.id === edge.to);
        return <li key={i} className="break-words rounded-lg bg-raised px-3 py-2">
          <button type="button" className="text-left font-medium text-accent underline" onClick={() => setIndex(from)}>{spec.steps[from]?.label ?? edge.from}</button>
          {' → '}
          <button type="button" className="text-left font-medium text-accent underline" onClick={() => setIndex(to)}>{spec.steps[to]?.label ?? edge.to}</button>
          {edge.label && <span className="block text-fg-dim">{edge.label}</span>}
        </li>;
      })}</ol>
    </section>
  </div>;
}

export function TimelineWidget({ spec }: { spec: Spec<'timeline'> }) {
  const [selected, setSelected] = useState<number | null>(null);
  const min = Math.min(...spec.events.map(e => e.start));
  const max = Math.max(...spec.events.map(e => e.end ?? e.start));
  const span = max - min || 1;
  const lanes = [...new Set(spec.events.map(e => e.lane ?? ''))];
  return <div className="space-y-3">
    <div className="space-y-2">{lanes.map(lane => <div key={lane} className="flex items-center gap-2">
      {lane && <span className="w-20 shrink-0 break-words text-xs">{lane}</span>}
      <div className="relative min-w-0 flex-1" style={{ height: Math.max(32, spec.events.filter(e => (e.lane ?? '') === lane).length * 28) }}>
        {spec.events.map((event, i) => (event.lane ?? '') !== lane ? null : <button key={i} type="button" title={`${event.label}: ${event.start}${event.end === undefined ? '' : `–${event.end}`} ${spec.unit}`} aria-label={event.label} aria-pressed={selected === i} onClick={() => setSelected(i)} className="absolute h-5 rounded-full border border-accent bg-accent/40 text-left text-[11px] text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" style={{ left: `${(event.start - min) / span * 100}%`, top: spec.events.slice(0, i).filter(e => (e.lane ?? '') === lane).length * 28, width: event.end === undefined ? 12 : `max(12px, ${(event.end - event.start) / span * 100}%)`, transform: event.end === undefined ? 'translateX(-50%)' : undefined }}><span className="sr-only">{event.label}</span></button>)}
      </div>
    </div>)}</div>
    <div className="flex justify-between text-xs text-fg-dim"><span>{min} {spec.unit}</span><span>{(min + max) / 2} {spec.unit}</span><span>{max} {spec.unit}</span></div>
    <ul className="space-y-1 text-sm">{spec.events.map((event, i) => <li key={i}><button type="button" className="text-left text-accent underline" aria-pressed={selected === i} onClick={() => setSelected(i)}>{event.label}</button>{' · '}{event.start}{event.end === undefined ? '' : `–${event.end}`} {spec.unit}</li>)}</ul>
    {selected !== null && <div className="rounded-lg bg-raised p-3"><strong>{spec.events[selected].label}</strong><p className="text-sm text-fg-dim">{spec.events[selected].detail}</p></div>}
  </div>;
}

export function TreeWidget({ spec }: { spec: Spec<'tree'> }) {
  const paths = useMemo(() => { const result: { id: string; depth: number }[] = []; const visit = (node: FigureTreeNode, id: string, depth: number) => { result.push({ id, depth }); node.children?.forEach((child, i) => visit(child, `${id}.${i}`, depth + 1)); }; visit(spec.root, '0', 0); return result; }, [spec.root]);
  const [expanded, setExpanded] = useState(() => new Set(paths.filter(p => p.depth < 2).map(p => p.id)));
  const [details, setDetails] = useState<Set<string>>(() => new Set());
  const toggle = (set: Set<string>, id: string) => { const next = new Set(set); next.has(id) ? next.delete(id) : next.add(id); return next; };
  const render = (node: FigureTreeNode, id: string): React.ReactNode => <li key={id} className="my-1">
    <div className="flex items-start gap-1">{node.children?.length ? <button type="button" aria-label={`${node.label} ${expanded.has(id) ? '접기' : '펼치기'}`} aria-expanded={expanded.has(id)} onClick={() => setExpanded(s => toggle(s, id))} className="w-5 shrink-0">{expanded.has(id) ? '▾' : '▸'}</button> : <span className="w-5 shrink-0" />}
      <button type="button" className="min-w-0 break-words text-left hover:text-accent" aria-expanded={node.detail ? details.has(id) : undefined} onClick={() => setDetails(s => toggle(s, id))}>{node.label}</button></div>
    {node.detail && details.has(id) && <p className="ml-6 text-sm text-fg-dim">{node.detail}</p>}
    {expanded.has(id) && node.children && <ul className="ml-2.5 border-l border-line pl-3">{node.children.map((child, i) => render(child, `${id}.${i}`))}</ul>}
  </li>;
  return <div className="space-y-2"><div className="flex gap-2"><button type="button" className={smallBtnCls} onClick={() => setExpanded(new Set(paths.map(p => p.id)))}>모두 펼치기</button><button type="button" className={smallBtnCls} onClick={() => setExpanded(new Set())}>모두 접기</button></div><ul>{render(spec.root, '0')}</ul></div>;
}

const COLORS = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab'];
type SimNode = SimulationNodeDatum & { id: string; label: string; group?: string; detail?: string };
type SimEdge = SimulationLinkDatum<SimNode> & { source: string | SimNode; target: string | SimNode; weight?: number; sign?: '+' | '-' };

export function NetworkWidget({ spec }: { spec: Spec<'network'> }) {
  const expanded = useFigureExpanded();
  const groups = useMemo(() => [...new Set(spec.nodes.map(n => n.group ?? '기타'))], [spec.nodes]);
  const [active, setActive] = useState(() => new Set(groups));
  const [selected, setSelected] = useState<string | null>(null);
  const layout = useMemo(() => {
    const nodes: SimNode[] = spec.nodes.map(n => ({ ...n }));
    const edges: SimEdge[] = spec.edges.map(e => ({ ...e }));
    const simulation = forceSimulation(nodes).force('link', forceLink<SimNode, SimEdge>(edges).id(n => n.id).distance(60)).force('charge', forceManyBody().strength(-160)).force('center', forceCenter(0, 0)).force('collide', forceCollide(18)).stop();
    simulation.tick(300);
    return { nodes, edges };
  }, [spec]);
  const visible = layout.nodes.filter(n => active.has(n.group ?? '기타'));
  const ids = new Set(visible.map(n => n.id));
  const edges = layout.edges.filter(e => ids.has((e.source as SimNode).id) && ids.has((e.target as SimNode).id));
  const neighbors = new Set<string>(selected ? [selected] : []);
  edges.forEach(e => { const a = (e.source as SimNode).id, b = (e.target as SimNode).id; if (a === selected) neighbors.add(b); if (b === selected) neighbors.add(a); });
  const xs = layout.nodes.map(n => n.x ?? 0), ys = layout.nodes.map(n => n.y ?? 0);
  const x = Math.min(...xs) - 45, y = Math.min(...ys) - 45, width = Math.max(...xs) - x + 45, height = Math.max(...ys) - y + 45;
  const selectedNode = visible.find(n => n.id === selected);
  return <div className="space-y-3"><ToggleChips items={groups} active={active} onToggle={group => setActive(old => { const next = new Set(old); next.has(group) ? next.delete(group) : next.add(group); return next; })} />
    <svg viewBox={`${x} ${y} ${width} ${height}`} className="w-full" style={{ height: expanded ? 'min(60vh, 600px)' : 320 }} role="img" aria-label="관계 네트워크">
      {edges.map((e, i) => { const a = e.source as SimNode, b = e.target as SimNode; return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={e.sign === '-' ? 'var(--pr-danger)' : 'var(--pr-fg-dim)'} strokeDasharray={e.sign === '-' ? '5 4' : undefined} strokeWidth={Math.max(1, Math.min(6, Math.sqrt(Math.abs(e.weight ?? 1))))} opacity={selected && a.id !== selected && b.id !== selected ? 0.15 : 0.7} />; })}
      {visible.map(n => <g key={n.id} role="button" tabIndex={0} aria-label={n.label} aria-pressed={selected === n.id} onClick={() => setSelected(selected === n.id ? null : n.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(selected === n.id ? null : n.id); } }} opacity={selected && !neighbors.has(n.id) ? 0.2 : 1} style={{ cursor: 'pointer' }}><circle cx={n.x} cy={n.y} r={12} fill={COLORS[groups.indexOf(n.group ?? '기타') % COLORS.length]} stroke={selected === n.id ? 'var(--pr-fg)' : 'transparent'} strokeWidth={2} /><text x={n.x} y={(n.y ?? 0) + 4} textAnchor="middle" fontSize={10} fill="white">{spec.nodes.findIndex(node => node.id === n.id) + 1}</text></g>)}
    </svg>
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">{visible.map(n => <li key={n.id}><button type="button" className="break-words text-left text-accent underline" aria-pressed={selected === n.id} onClick={() => setSelected(selected === n.id ? null : n.id)}>{spec.nodes.findIndex(node => node.id === n.id) + 1}. {n.label}</button></li>)}</ul>
    {selectedNode && <div className="rounded-lg bg-raised p-3"><strong>{selectedNode.label}</strong>{selectedNode.detail && <p className="text-sm text-fg-dim">{selectedNode.detail}</p>}</div>}
  </div>;
}

export function VennWidget({ spec }: { spec: Spec<'venn'> }) {
  const expanded = useFigureExpanded();
  const [selected, setSelected] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const three = spec.sets.length === 3;
  const circles = three ? [{ x: 145, y: 125 }, { x: 255, y: 125 }, { x: 200, y: 210 }] : [{ x: 155, y: 145 }, { x: 245, y: 145 }];
  const centers: Record<string, [number, number]> = three ? { '0': [110, 105], '1': [290, 105], '2': [200, 260], '0,1': [200, 90], '0,2': [150, 195], '1,2': [250, 195], '0,1,2': [200, 150] } : { '0': [115, 145], '1': [285, 145], '0,1': [200, 145] };
  return <div className="space-y-3"><svg viewBox="0 0 400 340" className="w-full" style={{ height: expanded ? 'min(60vh, 600px)' : 280 }} role="img" aria-label="집합과 교집합">
    {spec.sets.map((set, i) => <g key={set.name}><circle cx={circles[i].x} cy={circles[i].y} r={90} fill={COLORS[i]} fillOpacity={hover === i ? 0.4 : 0.2} stroke={COLORS[i]} strokeWidth={hover === i ? 3 : 1.5} /><text x={circles[i].x} y={three && i === 2 ? 328 : 22} textAnchor="middle" fill="currentColor" fontSize={13}>{String.fromCharCode(65 + i)}</text></g>)}
    {spec.regions.map((region, i) => { const key = region.sets.map(name => spec.sets.findIndex(s => s.name === name)).sort((a, b) => a - b).join(','); const point = centers[key]; if (!point) return null; return <g key={i} role="button" tabIndex={0} aria-label={`${region.sets.join(' ∩ ')}: ${region.count}`} aria-pressed={selected === i} onClick={() => setSelected(i)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(i); } }} style={{ cursor: 'pointer' }}><circle cx={point[0]} cy={point[1]} r={16} fill={selected === i ? 'var(--pr-accent)' : 'var(--pr-surface)'} fillOpacity={0.9} /><text x={point[0]} y={point[1] + 4} textAnchor="middle" fontSize={12} fill={selected === i ? 'white' : 'currentColor'}>{region.count}</text></g>; })}
  </svg><ul className="space-y-1 text-sm">{spec.sets.map((set, i) => <li key={set.name}><span tabIndex={0} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}><strong style={{ color: COLORS[i] }}>{String.fromCharCode(65 + i)}</strong> · {set.name} ({set.size})</span></li>)}</ul>{selected !== null && <div className="rounded-lg bg-raised p-3"><strong>{spec.regions[selected].sets.join(' ∩ ')}</strong>{spec.regions[selected].members?.length ? <ul className="mt-1 list-disc pl-5 text-sm">{spec.regions[selected].members!.map((member, i) => <li key={i}>{member}</li>)}</ul> : <p className="text-sm text-fg-dim">구성원 정보 없음</p>}</div>}</div>;
}
