import dagre from '@dagrejs/dagre';
import {
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { smallBtnCls } from '../components/Dialog';
import { JobBar } from '../components/JobBar';
import { PageChip } from '../components/Markdown';
import { ModelBadge } from '../components/ModelBadge';
import { useToast } from '../components/Toast';
import { usePaper } from '../state/paper';
import { useJob } from '../state/useJob';
import { useViewer } from '../state/viewer';
import type { ArtifactDto } from '../types';

type MindKind = 'background' | 'question' | 'method' | 'finding' | 'limitation' | 'concept';

interface MindNode {
  label: string;
  kind?: MindKind;
  bullets?: string[];
  pages?: number[];
  children?: MindNode[];
}

type Positions = Record<string, { x: number; y: number }>;

interface MindmapContent {
  root: MindNode;
  positions: Positions;
}

type MindData = { label: string; kind: MindKind | null; bullets: string[]; pages: number[]; isRoot: boolean };
type MindFlowNode = Node<MindData, 'mind'>;

const NODE_W = 260;
const nodeHeight = (bullets: number) => 44 + 20 * bullets;

const KIND_BORDER: Record<MindKind, string> = {
  background: 'border-l-slate-400',
  question: 'border-l-violet-500',
  method: 'border-l-sky-500',
  finding: 'border-l-emerald-500',
  limitation: 'border-l-amber-500',
  concept: 'border-l-rose-500',
};

/** Flatten the tree into path-id nodes (`0`, `0.2`, `0.2.1`) and parent→child edges. */
function flatten(root: MindNode): { nodes: MindFlowNode[]; edges: Edge[] } {
  const nodes: MindFlowNode[] = [];
  const edges: Edge[] = [];
  const walk = (n: MindNode, id: string, parent: string | null) => {
    nodes.push({
      id,
      type: 'mind',
      position: { x: 0, y: 0 },
      data: { label: n.label, kind: n.kind ?? null, bullets: n.bullets ?? [], pages: n.pages ?? [], isRoot: parent === null },
    });
    if (parent !== null) edges.push({ id: `${parent}->${id}`, source: parent, target: id, type: 'smoothstep' });
    n.children?.forEach((c, i) => walk(c, `${id}.${i}`, id));
  };
  walk(root, '0', null);
  return { nodes, edges };
}

/** dagre LR layout; stored positions win over the computed ones. */
function layout(nodes: MindFlowNode[], edges: Edge[], positions: Positions): MindFlowNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 90 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: nodeHeight(n.data.bullets.length) });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map((n) => {
    const stored = positions[n.id];
    if (stored) return { ...n, position: stored };
    const p = g.node(n.id) as { x: number; y: number };
    return { ...n, position: { x: p.x - NODE_W / 2, y: p.y - nodeHeight(n.data.bullets.length) / 2 } };
  });
}

function MindCard({ data }: NodeProps<MindFlowNode>) {
  const { jumpToPage } = useViewer();
  const border = data.kind ? KIND_BORDER[data.kind] : data.isRoot ? 'border-l-fg' : 'border-l-line-strong';
  return (
    <div className={`rounded-md border border-line border-l-4 bg-surface px-2.5 py-1.5 shadow-sm ${border}`} style={{ width: NODE_W }}>
      {!data.isRoot && <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-line-strong" />}
      <div className={`font-bold leading-snug text-fg ${data.isRoot ? 'text-[14px]' : 'text-[13px]'}`}>{data.label}</div>
      {data.bullets.length > 0 && (
        <ul className="mt-0.5 list-disc pl-4 text-[11.5px] leading-[20px] text-fg-muted">
          {data.bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      )}
      {data.pages.length > 0 && (
        <div className="nodrag mt-1 flex flex-wrap gap-y-0.5">
          {data.pages.map((p) => (
            <PageChip key={p} page={p} onJump={jumpToPage} />
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-line-strong" />
    </div>
  );
}

const nodeTypes = { mind: MindCard };

export function MindmapPanel() {
  return (
    <ReactFlowProvider>
      <MindmapInner />
    </ReactFlowProvider>
  );
}

function MindmapInner() {
  const { paper, reloadPaper } = usePaper();
  const { tab, pdfMode, setPdfMode } = useViewer();
  const toast = useToast();
  const { fitView, getNodes } = useReactFlow<MindFlowNode, Edge>();
  const [nodes, setNodes, onNodesChange] = useNodesState<MindFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [artifact, setArtifact] = useState<ArtifactDto<MindmapContent> | null>(null);
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fitSoon = useCallback(() => {
    setTimeout(() => void fitView({ padding: 0.15 }), 60);
  }, [fitView]);

  const applyArtifact = useCallback(
    (a: ArtifactDto<MindmapContent> | null) => {
      setArtifact(a);
      if (!a) {
        setNodes([]);
        setEdges([]);
        return;
      }
      const flat = flatten(a.content.root);
      setNodes(layout(flat.nodes, flat.edges, a.content.positions));
      setEdges(flat.edges);
      fitSoon();
    },
    [setNodes, setEdges, fitSoon],
  );

  const loadArtifact = useCallback(async () => {
    try {
      const a = await api<ArtifactDto<string>>(`/api/papers/${paper.id}/artifacts/mindmap`);
      applyArtifact({ ...a, content: JSON.parse(a.content) as MindmapContent });
    } catch {
      applyArtifact(null);
    } finally {
      setLoaded(true);
    }
  }, [paper.id, applyArtifact]);

  useEffect(() => {
    void loadArtifact();
  }, [loadArtifact]);

  const job = useJob('mindmap', {
    onFinish(j) {
      if (j.status === 'done') {
        void loadArtifact();
        reloadPaper();
      }
    },
  });

  // The panel stays mounted while hidden: re-fit when it becomes visible or the PDF column toggles.
  useEffect(() => {
    if (tab === 'mindmap' && nodes.length) fitSoon();
  }, [tab, pdfMode]);


  useEffect(() => () => {
    clearTimeout(saveTimer.current);
  }, []);

  const putPositions = useCallback(
    (positions: Positions) =>
      api(`/api/papers/${paper.id}/artifacts/mindmap/positions`, { method: 'PUT', json: { positions } }).catch((e: unknown) =>
        toast((e as Error).message, { tone: 'error' }),
      ),
    [paper.id, toast],
  );

  const onNodeDragStop = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const positions: Positions = {};
      for (const n of getNodes()) positions[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
      void putPositions(positions);
    }, 500);
  }, [getNodes, putPositions]);

  const generate = async () => {
    if (artifact && !confirm('마인드맵을 다시 생성할까요? 지금 배치는 사라집니다.')) return;
    try {
      const { jobId } = await api<{ jobId: string }>(`/api/papers/${paper.id}/mindmap`, { method: 'POST' });
      job.attach(jobId);
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  };

  const autoArrange = async () => {
    if (!artifact) return;
    clearTimeout(saveTimer.current);
    await putPositions({});
    applyArtifact({ ...artifact, content: { ...artifact.content, positions: {} } });
  };

  const btn = smallBtnCls;
  const big = pdfMode === 'full-panel';

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-line px-3 py-2">
        <div className="flex items-center gap-1.5">
          <button className={btn} disabled={job.running} onClick={() => void generate()}>
            {artifact ? '다시 생성' : '생성'}
          </button>
          <button className={btn} disabled={!artifact || job.running} onClick={() => void autoArrange()}>
            자동 정렬
          </button>
          <button
            className={
              big
                ? 'inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-inverse bg-inverse px-2 text-[12px] text-inverse-fg transition-[transform,background-color,color,border-color,opacity] duration-150 ease-out hover:opacity-90 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50'
                : btn
            }
            aria-pressed={big}
            onClick={() => setPdfMode(big ? 'split' : 'full-panel')}
          >
            크게 보기
          </button>
          {artifact && (
            <span className="ml-auto flex min-w-0 items-center gap-1 truncate text-[11px] text-fg-dim">
              <ModelBadge by={artifact.by} />
              <span className="shrink-0">· {artifact.updatedAt.slice(0, 10)}</span>
            </span>
          )}
        </div>
        <JobBar job={job.job} onCancel={() => void job.cancel()} label="마인드맵 생성 중…" />
      </div>
      <div className="relative min-h-0 flex-1">
        {artifact ? (
          <ReactFlow
            colorMode="system"
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={onNodeDragStop}
            nodesConnectable={false}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.1}
            proOptions={{ hideAttribution: true }}
          >
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>
        ) : (
          loaded &&
          !job.running && (
            <div className="p-6 text-[13px] text-fg-muted">
              논문 구조를 마인드맵으로 만듭니다. 위의 <b>생성</b>을 누르세요.
            </div>
          )
        )}
      </div>
    </div>
  );
}
