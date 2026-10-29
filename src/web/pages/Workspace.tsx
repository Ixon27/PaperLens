import { lazy, Suspense, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Link } from 'wouter';
import {
  ArrowLeft,
  ChartScatter,
  FileSearch,
  GitFork,
  Highlighter,
  Languages,
  MessagesSquare,
  Network,
  PanelRightClose,
  PanelRightOpen,
  Quote,
  type LucideIcon,
} from 'lucide-react';
import { FIELD_LABELS } from '../../shared/fields';
import { api } from '../api';
import { btnCls, chipCls, ghostBtnCls } from '../components/Dialog';
import { ExportDialog } from '../components/ExportDialog';
import { FieldConfirmBar } from '../components/FieldConfirmBar';
import { JobBar, Spinner } from '../components/JobBar';
import { LiquidDrop } from '../components/LiquidDrop';
import { MetadataDialog } from '../components/MetadataDialog';
import { useToast } from '../components/Toast';
import { AnalysisPanel } from '../panels/AnalysisPanel';
import { CitationsPanel } from '../panels/CitationsPanel';
import { HighlightsPanel } from '../panels/HighlightsPanel';
import { LineagePanel } from '../panels/LineagePanel';
import { MindmapPanel } from '../panels/MindmapPanel';
import { OverviewPanel } from '../panels/OverviewPanel';
import { TranslationPane } from '../panels/TranslationPane';
import { PdfPane } from '../pdf/PdfPane';
import { PaperProvider, usePaper } from '../state/paper';
import { SyncHoverProvider } from '../state/syncHover';
import { useJob, type JobHandle } from '../state/useJob';
import { useViewer, ViewerProvider, type TabId } from '../state/viewer';
import type { PaperDto } from '../types';
import { authorShort } from './Library';

const FiguresPanel = lazy(() => import('../panels/FiguresPanel').then((m) => ({ default: m.FiguresPanel })));

const TABS: { id: TabId; label: string; Icon: LucideIcon; needsText: boolean }[] = [
  { id: 'overview', label: '요약·토론', Icon: MessagesSquare, needsText: true },
  { id: 'analysis', label: 'Deep Research', Icon: FileSearch, needsText: true },
  { id: 'figures', label: '그림', Icon: ChartScatter, needsText: true },
  { id: 'mindmap', label: '마인드맵', Icon: Network, needsText: true },
  { id: 'lineage', label: '계보', Icon: GitFork, needsText: true },
  { id: 'citations', label: '인용·관련', Icon: Quote, needsText: true },
  { id: 'highlights', label: '하이라이트', Icon: Highlighter, needsText: false },
];

const PANELS: Record<TabId, () => ReactNode> = {
  overview: () => <OverviewPanel />,
  analysis: () => <AnalysisPanel />,
  figures: () => <Suspense fallback={<Spinner text="불러오는 중…" />}><FiguresPanel /></Suspense>,
  mindmap: () => <MindmapPanel />,
  lineage: () => <LineagePanel />,
  citations: () => <CitationsPanel />,
  highlights: () => <HighlightsPanel />,
};

/** Reading column share of the window, kept separately for with and without the translation pane. */
const SPLIT_KEY = 'pr.split';
const SPLIT_TR_KEY = 'pr.split.tr';
/** PDF share of the PDF + translation pair. */
const TR_SPLIT_KEY = 'pr.trSplit';
const MIN_PANEL_PX = 360;
const SCAN_TEXT = '글자를 인식할 수 없는 스캔 PDF라 AI 기능을 쓸 수 없습니다';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function storedFraction(key: string, fallback: number, lo: number, hi: number): number {
  const v = parseFloat(localStorage.getItem(key) ?? '');
  return Number.isFinite(v) && v > lo && v < hi ? v : fallback;
}

/** Follow a pointer drag on window until release. */
function trackDrag(onMove: (ev: PointerEvent) => void, onEnd: () => void) {
  const up = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', up);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    onEnd();
  };
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', up);
}

function Separator({ active, hidden, onPointerDown }: { active: boolean; hidden?: boolean; onPointerDown(e: ReactPointerEvent<HTMLDivElement>): void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      className={`group relative w-2 shrink-0 cursor-col-resize ${hidden ? 'pointer-events-none opacity-0' : ''}`}
    >
      <div className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors duration-150 ${active ? 'bg-accent' : 'bg-line group-hover:bg-accent'}`} />
    </div>
  );
}

export function Workspace({ id }: { id: string }) {
  const [paper, setPaper] = useState<PaperDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadPaper = useCallback(async () => {
    try {
      setPaper(await api<PaperDto>(`/api/papers/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void reloadPaper();
  }, [reloadPaper]);

  if (error) return <div className="p-8 text-[14px] text-danger">{error}</div>;
  if (!paper) return <div className="p-8 text-[13px] text-fg-muted">불러오는 중…</div>;
  return (
    <ViewerProvider>
      <PaperProvider paper={paper} reloadPaper={reloadPaper}>
        <SyncHoverProvider>
          <WorkspaceInner />
        </SyncHoverProvider>
      </PaperProvider>
    </ViewerProvider>
  );
}

function WorkspaceInner() {
  const { paper, reloadPaper, noText } = usePaper();
  const { tab, pdfMode, setPdfMode, showTranslation, setShowTranslation, sidebarOpen } = useViewer();
  const [metaOpen, setMetaOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [splits, setSplits] = useState(() => ({
    plain: storedFraction(SPLIT_KEY, 0.58, 0.15, 0.9),
    tr: storedFraction(SPLIT_TR_KEY, 0.7, 0.15, 0.95),
  }));
  const split = showTranslation ? splits.tr : splits.plain;
  const [trSplit, setTrSplit] = useState(() => clamp(storedFraction(TR_SPLIT_KEY, 0.5, 0, 1), 0.3, 0.7));
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set([tab]));
  const [dragging, setDragging] = useState<'main' | 'reading' | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pdfColRef = useRef<HTMLDivElement>(null);
  const readRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setVisited((s) => (s.has(tab) ? s : new Set(s).add(tab)));
  }, [tab]);

  // Import job (PDF download / extraction) — refresh the paper when it ends.
  const importJob = useJob('import', { onFinish: () => void reloadPaper() });

  // Reading column | panel.
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const body = bodyRef.current;
    if (!body) return;
    const rect = body.getBoundingClientRect();
    const which = showTranslation ? 'tr' : 'plain';
    const minLeft = showTranslation ? 480 : 240;
    let value = split;
    setDragging('main');
    trackDrag(
      (ev) => {
        value = Math.min(Math.max(ev.clientX - rect.left, minLeft), rect.width - MIN_PANEL_PX) / rect.width;
        setSplits((s) => ({ ...s, [which]: value }));
      },
      () => {
        setDragging(null);
        localStorage.setItem(which === 'tr' ? SPLIT_TR_KEY : SPLIT_KEY, String(value));
      },
    );
  };

  // PDF | translation.
  const startReadingDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const area = readRef.current;
    if (!area) return;
    const rect = area.getBoundingClientRect();
    let value = trSplit;
    setDragging('reading');
    trackDrag(
      (ev) => {
        value = clamp((ev.clientX - rect.left) / rect.width, 0.3, 0.7);
        setTrSplit(value);
      },
      () => {
        setDragging(null);
        localStorage.setItem(TR_SPLIT_KEY, String(value));
      },
    );
  };

  const meta = [authorShort(paper), paper.year, paper.journal].filter(Boolean).join(' · ');
  const fullPanel = pdfMode === 'full-panel';

  // The hidden reading column keeps its layout (no PDF.js re-render) but must not take focus.
  useEffect(() => {
    if (pdfColRef.current) pdfColRef.current.inert = fullPanel;
  }, [fullPanel]);

  // Closing the sidebar while a panel fills the window brings the PDF back.
  useEffect(() => {
    if (!sidebarOpen && fullPanel) setPdfMode('split');
  }, [sidebarOpen, fullPanel, setPdfMode]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        <Link href="/" className={`${ghostBtnCls} shrink-0`}>
          <ArrowLeft size={15} />
          라이브러리
        </Link>
        <div className="h-5 w-px shrink-0 bg-line" />
        <button className="min-w-0 flex-1 truncate rounded-md px-1 text-left text-[14px] font-semibold text-fg hover:text-accent" title="논문 정보 수정" onClick={() => setMetaOpen(true)}>
          {paper.title}
          {meta && <span className="ml-2 font-normal text-fg-muted">{meta}</span>}
        </button>
        <button
          className={`inline-flex h-7 shrink-0 items-center rounded-full px-2.5 text-[12px] font-medium whitespace-nowrap transition-opacity duration-150 hover:opacity-80 ${
            paper.field ? 'bg-accent-soft text-accent' : 'bg-warning-soft text-warning'
          }`}
          title="분야 바꾸기"
          onClick={() => setMetaOpen(true)}
        >
          {paper.field ? FIELD_LABELS[paper.field] : '분야 미정'}
        </button>
        <button className={`${chipCls(showTranslation)} shrink-0`} aria-pressed={showTranslation} onClick={() => setShowTranslation(!showTranslation)}>
          <Languages size={14} />
          번역
        </button>
        <button className={`${btnCls} shrink-0`} onClick={() => setExportOpen(true)}>
          내보내기
        </button>
        <button className={`${ghostBtnCls} shrink-0`} onClick={() => setMetaOpen(true)}>
          정보 수정
        </button>
      </div>
      {paper.field === null && <FieldConfirmBar key={paper.id} />}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div ref={bodyRef} className="relative flex min-w-0 flex-1 overflow-hidden">
          <div
            ref={pdfColRef}
            aria-hidden={fullPanel || undefined}
            className="pr-fade-in flex min-w-0 shrink-0 transition-[transform,opacity] duration-[380ms] ease-in-out motion-reduce:transition-none"
            style={{
              // The panel keeps its minimum width: the reading column gives way on narrow windows.
              width: sidebarOpen ? `min(calc(${split * 100}% - 4px), calc(100% - ${MIN_PANEL_PX + 8}px))` : '100%',
              transform: fullPanel ? 'translateX(-32px)' : undefined,
              opacity: fullPanel ? 0 : 1,
              pointerEvents: fullPanel ? 'none' : undefined,
            }}
          >
            <div ref={readRef} className="flex h-full min-w-0 flex-1">
              <div className="h-full min-w-0 shrink-0" style={{ width: showTranslation ? `calc(${trSplit * 100}% - 4px)` : '100%' }}>
                {paper.hasPdf ? <PdfPane /> : <PdfDropZone importJob={importJob} />}
              </div>
              {showTranslation && (
                <>
                  <Separator active={dragging === 'reading'} onPointerDown={startReadingDrag} />
                  <div className="h-full min-w-0 flex-1 bg-surface">
                    {!paper.hasPdf ? <Blocked text="PDF를 먼저 추가하세요" /> : noText ? <Blocked text={SCAN_TEXT} /> : <TranslationPane />}
                  </div>
                </>
              )}
            </div>
          </div>
          {sidebarOpen && <Separator active={dragging === 'main'} hidden={fullPanel} onPointerDown={startDrag} />}
          {/* Closed, the panels stay mounted (hidden) so chats and jobs keep their state. */}
          <div
            className={`pr-panel-enter absolute inset-y-0 right-0 flex flex-col bg-surface ${sidebarOpen ? '' : 'hidden'} ${
              dragging === 'main' ? '' : 'transition-[width] duration-[380ms] ease-in-out motion-reduce:transition-none'
            }`}
            style={{ width: fullPanel ? '100%' : `calc(${(1 - split) * 100}% - 4px)`, minWidth: MIN_PANEL_PX }}
          >
            <div className="relative min-h-0 flex-1">
              {TABS.map((t) => {
                if (!visited.has(t.id)) return null;
                let body: ReactNode;
                if (!paper.hasPdf) body = <Blocked text="PDF를 먼저 추가하세요" />;
                else if (noText && t.needsText) body = <Blocked text={SCAN_TEXT} />;
                else body = PANELS[t.id]();
                return (
                  <div key={t.id} role="region" aria-label={t.label} className="absolute inset-0 overflow-y-auto" hidden={tab !== t.id} data-tab={t.id}>
                    {body}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <SidebarRail />
      </div>
      {metaOpen && <MetadataDialog paper={paper} onClose={() => setMetaOpen(false)} onSaved={() => void reloadPaper()} />}
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
    </div>
  );
}

/** Panel switcher right of the window: icon buttons with hover labels, and the sidebar toggle. */
function SidebarRail() {
  const { tab, setTab, sidebarOpen, setSidebarOpen } = useViewer();
  return (
    <nav aria-label="우측 사이드바" className="flex w-12 shrink-0 flex-col items-center gap-1 border-l border-line bg-surface py-2">
      <RailButton label={sidebarOpen ? '우측 사이드바 닫기' : '우측 사이드바 열기'} expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}>
        {sidebarOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
      </RailButton>
      <div className="my-1 h-px w-6 bg-line" />
      {TABS.map(({ id, label, Icon }) => (
        <RailButton
          key={id}
          id={id}
          label={label}
          active={sidebarOpen && tab === id}
          onClick={() => {
            setTab(id);
            setSidebarOpen(true);
          }}
        >
          <Icon size={17} />
        </RailButton>
      ))}
    </nav>
  );
}

function RailButton({
  id,
  label,
  active,
  expanded,
  onClick,
  children,
}: {
  id?: TabId;
  label: string;
  /** Tab buttons only: the open panel. */
  active?: boolean;
  /** The sidebar toggle only. */
  expanded?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      className={`group relative grid h-9 w-9 place-items-center rounded-lg transition-colors duration-150 ${
        active ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-hover hover:text-fg'
      }`}
      aria-label={label}
      aria-pressed={active}
      aria-expanded={expanded}
      data-tab-id={id}
      onClick={onClick}
    >
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute top-1/2 right-full z-50 mr-2 -translate-y-1/2 rounded-md bg-inverse px-2 py-1 text-[12px] font-medium whitespace-nowrap text-inverse-fg opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-hover:delay-300 group-focus-visible:opacity-100"
      >
        {label}
      </span>
    </button>
  );
}

function Blocked({ text }: { text: string }) {
  return <div className="p-6 text-[13px] text-fg-muted">{text}</div>;
}

function PdfDropZone({ importJob }: { importJob: JobHandle }) {
  const { paper, reloadPaper } = usePaper();
  const [over, setOver] = useState(false);
  const [dropAt, setDropAt] = useState<{ x: number; y: number; key: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      toast('PDF 파일만 붙일 수 있습니다', { tone: 'error' });
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { jobId } = await api<{ jobId: string }>(`/api/papers/${paper.id}/pdf`, { method: 'POST', body: fd });
      importJob.attach(jobId);
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    } finally {
      setUploading(false);
    }
  };

  if (importJob.running) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
        <div className="text-[14px] text-fg-muted">PDF 가져오는 중…</div>
        <div className="w-full max-w-md">
          <JobBar job={importJob.job} onCancel={() => void importJob.cancel()} />
        </div>
      </div>
    );
  }

  return (
    <div
      className={`relative m-4 flex h-[calc(100%-2rem)] flex-col items-center justify-center overflow-hidden rounded-2xl border border-dashed p-8 text-center transition-colors duration-150 ${
        over ? 'border-accent/60 bg-accent-soft' : 'border-line-strong bg-surface'
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        setDropAt({ x: e.clientX - rect.left, y: e.clientY - rect.top, key: Date.now() });
        setOver(false);
        void upload(e.dataTransfer.files[0]);
      }}
      data-testid="pdf-dropzone"
    >
      <LiquidDrop active={over} dropAt={dropAt} />
      <div className="relative flex flex-col items-center gap-3">
        {importJob.job?.message && importJob.job.status === 'done' && <div className="text-[13px] text-warning">{importJob.job.message}</div>}
        {importJob.job?.status === 'error' && <div className="text-[13px] text-danger">{importJob.job.error}</div>}
        <div className="text-[15px] font-semibold text-fg">PDF를 여기에 끌어다 놓으세요</div>
        <div className="text-[12.5px] text-fg-muted">가지고 있는 PDF를 이 논문에 연결합니다.</div>
        <button className={btnCls} disabled={uploading} onClick={() => fileRef.current?.click()}>
          {uploading ? '올리는 중…' : 'PDF 선택'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf"
          hidden
          onChange={(e) => {
            void upload(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <button className="text-[12px] text-fg-dim underline hover:text-fg" onClick={() => void reloadPaper()}>
          다시 확인
        </button>
      </div>
    </div>
  );
}
