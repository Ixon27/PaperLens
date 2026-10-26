import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Link } from 'wouter';
import { api } from '../api';
import { btnCls } from '../components/Dialog';
import { ExportDialog } from '../components/ExportDialog';
import { JobBar } from '../components/JobBar';
import { MetadataDialog } from '../components/MetadataDialog';
import { useToast } from '../components/Toast';
import { AnalysisPanel } from '../panels/AnalysisPanel';
import { ChatPanel } from '../panels/ChatPanel';
import { CitationsPanel } from '../panels/CitationsPanel';
import { HighlightsPanel } from '../panels/HighlightsPanel';
import { MindmapPanel } from '../panels/MindmapPanel';
import { TranslationPanel } from '../panels/TranslationPanel';
import { PdfPane } from '../pdf/PdfPane';
import { PaperProvider, usePaper } from '../state/paper';
import { useJob, type JobHandle } from '../state/useJob';
import { useViewer, ViewerProvider, type TabId } from '../state/viewer';
import type { PaperDto } from '../types';
import { authorShort } from './Library';

const TABS: { id: TabId; label: string; needsText: boolean }[] = [
  { id: 'translation', label: '번역', needsText: true },
  { id: 'analysis', label: '분석', needsText: true },
  { id: 'chat', label: '채팅', needsText: true },
  { id: 'mindmap', label: '마인드맵', needsText: true },
  { id: 'citations', label: '인용·관련', needsText: true },
  { id: 'highlights', label: '하이라이트', needsText: false },
];

const PANELS: Record<TabId, () => ReactNode> = {
  translation: () => <TranslationPanel />,
  analysis: () => <AnalysisPanel />,
  chat: () => <ChatPanel />,
  mindmap: () => <MindmapPanel />,
  citations: () => <CitationsPanel />,
  highlights: () => <HighlightsPanel />,
};

const SPLIT_KEY = 'pr.split';
const MIN_PANEL_PX = 360;

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

  if (error) return <div className="p-8 text-[14px] text-red-600">{error}</div>;
  if (!paper) return <div className="p-8 text-[13px] text-stone-500">불러오는 중…</div>;
  return (
    <ViewerProvider>
      <PaperProvider paper={paper} reloadPaper={reloadPaper}>
        <WorkspaceInner />
      </PaperProvider>
    </ViewerProvider>
  );
}

function WorkspaceInner() {
  const { paper, reloadPaper, noText } = usePaper();
  const { tab, setTab, pdfMode } = useViewer();
  const [metaOpen, setMetaOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [split, setSplit] = useState(() => {
    const v = parseFloat(localStorage.getItem(SPLIT_KEY) ?? '');
    return Number.isFinite(v) && v > 0.15 && v < 0.9 ? v : 0.58;
  });
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set([tab]));
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setVisited((s) => (s.has(tab) ? s : new Set(s).add(tab)));
  }, [tab]);

  // Import job (PDF download / extraction) — refresh the paper when it ends.
  const importJob = useJob('import', { onFinish: () => void reloadPaper() });

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const body = bodyRef.current;
    if (!body) return;
    const rect = body.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const maxLeft = rect.width - MIN_PANEL_PX;
      const left = Math.min(Math.max(ev.clientX - rect.left, 240), maxLeft);
      setSplit(left / rect.width);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setSplit((s) => {
        localStorage.setItem(SPLIT_KEY, String(s));
        return s;
      });
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const meta = [authorShort(paper), paper.year, paper.journal].filter(Boolean).join(' · ');
  const fullPanel = pdfMode === 'full-panel';

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-stone-200 bg-white px-4">
        <Link href="/" className="shrink-0 text-[12px] text-stone-500 hover:text-stone-800">
          ← 라이브러리
        </Link>
        <button className="min-w-0 flex-1 truncate text-left text-[13.5px] font-semibold hover:underline" title="메타데이터 편집" onClick={() => setMetaOpen(true)}>
          {paper.title}
          {meta && <span className="ml-2 font-normal text-stone-500">{meta}</span>}
        </button>
        <button className={btnCls} onClick={() => setExportOpen(true)}>
          Obsidian으로 내보내기
        </button>
        <button className={btnCls} onClick={() => setMetaOpen(true)}>
          메타데이터
        </button>
      </div>
      <div ref={bodyRef} className="flex min-h-0 flex-1">
        <div className="min-w-0" style={fullPanel ? { display: 'none' } : { width: `calc(${split * 100}% - 3px)` }}>
          {paper.hasPdf ? <PdfPane /> : <PdfDropZone importJob={importJob} />}
        </div>
        {!fullPanel && <div className="w-1.5 shrink-0 cursor-col-resize bg-stone-200 hover:bg-blue-300" onPointerDown={startDrag} role="separator" aria-orientation="vertical" />}
        <div className="flex min-w-0 flex-1 flex-col bg-white" style={{ minWidth: MIN_PANEL_PX }}>
          <nav className="flex h-9 shrink-0 items-end gap-0.5 border-b border-stone-200 px-2" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`rounded-t-md px-3 py-1.5 text-[13px] ${tab === t.id ? 'border border-b-white border-stone-200 bg-white font-semibold text-stone-900' : 'text-stone-500 hover:text-stone-800'}`}
                style={tab === t.id ? { marginBottom: -1 } : undefined}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="relative min-h-0 flex-1">
            {TABS.map((t) => {
              if (!visited.has(t.id)) return null;
              let body: ReactNode;
              if (!paper.hasPdf) body = <Blocked text="PDF를 먼저 붙이세요" />;
              else if (noText && t.needsText) body = <Blocked text="텍스트 레이어가 없는 PDF — AI 기능을 쓸 수 없습니다" />;
              else body = PANELS[t.id]();
              return (
                <div key={t.id} role="tabpanel" className="absolute inset-0 overflow-y-auto" hidden={tab !== t.id} data-tab={t.id}>
                  {body}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {metaOpen && <MetadataDialog paper={paper} onClose={() => setMetaOpen(false)} onSaved={() => void reloadPaper()} />}
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
    </div>
  );
}

function Blocked({ text }: { text: string }) {
  return <div className="p-6 text-[13px] text-stone-500">{text}</div>;
}

function PdfDropZone({ importJob }: { importJob: JobHandle }) {
  const { paper, reloadPaper } = usePaper();
  const [over, setOver] = useState(false);
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
        <div className="text-[14px] text-stone-600">PDF 가져오는 중…</div>
        <div className="w-full max-w-md">
          <JobBar job={importJob.job} onCancel={() => void importJob.cancel()} />
        </div>
      </div>
    );
  }

  return (
    <div
      className={`m-4 flex h-[calc(100%-2rem)] flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 text-center ${over ? 'border-blue-500 bg-blue-50' : 'border-stone-300 bg-white'}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void upload(e.dataTransfer.files[0]);
      }}
      data-testid="pdf-dropzone"
    >
      {importJob.job?.message && importJob.job.status === 'done' && <div className="text-[13px] text-amber-700">{importJob.job.message}</div>}
      {importJob.job?.status === 'error' && <div className="text-[13px] text-red-600">{importJob.job.error}</div>}
      <div className="text-[15px] font-semibold text-stone-700">PDF를 여기에 끌어다 놓으세요</div>
      <div className="text-[12.5px] text-stone-500">대학 도서관 등에서 받은 PDF를 이 논문에 붙입니다.</div>
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
      <button className="text-[12px] text-stone-400 underline" onClick={() => void reloadPaper()}>
        새로고침
      </button>
    </div>
  );
}
