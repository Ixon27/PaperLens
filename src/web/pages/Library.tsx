import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { ArrowUp, FileUp, Loader2, Search, Trash2 } from 'lucide-react';
import { FIELDS, FIELD_LABELS, isFieldId, type FieldId } from '../../shared/fields';
import { api } from '../api';
import { JobBar } from '../components/JobBar';
import { LiquidDrop } from '../components/LiquidDrop';
import { useToast } from '../components/Toast';
import type { PaperDto } from '../types';

interface ImportResult {
  paperId: string;
  jobId?: string;
  duplicate?: boolean;
}
interface UploadResult extends Partial<ImportResult> {
  name: string;
  error?: string;
}

export function authorShort(p: Pick<PaperDto, 'authors'>): string {
  if (!p.authors.length) return '';
  return p.authors.length > 1 ? `${p.authors[0].family} et al.` : p.authors[0].family;
}

/** Upload PDFs; returns per-file results. */
export async function uploadPdfs(files: File[], field: FieldId | null): Promise<UploadResult[]> {
  const fd = new FormData();
  for (const f of files) fd.append('file', f);
  if (field) fd.append('field', field);
  return api<UploadResult[]>('/api/papers/upload', { method: 'POST', body: fd });
}

const isPdfDrag = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

export function Library() {
  const [papers, setPapers] = useState<PaperDto[] | null>(null);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [input, setInput] = useState('');
  const [importField, setImportField] = useState<FieldId | 'auto'>(() => {
    const stored = localStorage.getItem('pr.importField');
    return isFieldId(stored) ? stored : 'auto';
  });
  const [importing, setImporting] = useState(false);
  const [drop, setDrop] = useState<'idle' | 'over' | 'dropping'>('idle');
  const [dropAt, setDropAt] = useState<{ x: number; y: number; key: number } | null>(null);
  // null until the first list arrives; ids seen later get the entry animation.
  const knownIds = useRef<Set<string> | null>(null);
  const [newIds, setNewIds] = useState<ReadonlySet<string>>(() => new Set());
  const fileRef = useRef<HTMLInputElement>(null);
  const [, navigate] = useLocation();
  const toast = useToast();

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    const list = await api<PaperDto[]>(`/api/papers${debouncedQ ? `?q=${encodeURIComponent(debouncedQ)}` : ''}`);
    const known = knownIds.current;
    if (known === null) {
      knownIds.current = new Set(list.map((p) => p.id));
    } else {
      const fresh = list.filter((p) => !known.has(p.id)).map((p) => p.id);
      for (const id of fresh) known.add(id);
      if (fresh.length) setNewIds(new Set(fresh));
    }
    setPapers(list);
  }, [debouncedQ]);

  useEffect(() => {
    void load().catch((e: Error) => toast(e.message, { tone: 'error' }));
  }, [load, toast]);

  // Poll every 2 s while any card has a running job.
  const anyRunning = papers?.some((p) => p.job && (p.job.status === 'running' || p.job.status === 'queued'));
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  const doImport = async () => {
    if (!input.trim() || importing) return;
    setImporting(true);
    try {
      const r = await api<ImportResult>('/api/papers/import', { method: 'POST', json: { input, field: importField === 'auto' ? null : importField } });
      if (r.duplicate) toast('이미 라이브러리에 있습니다');
      setInput('');
      navigate(`/paper/${r.paperId}`);
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    } finally {
      setImporting(false);
    }
  };

  const doUpload = useCallback(
    async (files: File[]) => {
      const pdfs = files.filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
      if (!pdfs.length) {
        toast('PDF 파일만 가져올 수 있습니다', { tone: 'error' });
        return;
      }
      try {
        const results = await uploadPdfs(pdfs, importField === 'auto' ? null : importField);
        for (const r of results) {
          if (r.error) toast(`${r.name}: ${r.error}`, { tone: 'error' });
          else if (r.duplicate) toast(`이미 라이브러리에 있습니다: ${r.name}`);
        }
        const ok = results.filter((r) => r.paperId && !r.error);
        if (results.length === 1 && ok.length === 1) navigate(`/paper/${ok[0].paperId}`);
        else await load();
      } catch (e) {
        toast((e as Error).message, { tone: 'error' });
      }
    },
    [importField, load, navigate, toast],
  );

  // Window-wide drag & drop overlay.
  useEffect(() => {
    let depth = 0;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const enter = (e: DragEvent) => {
      if (!isPdfDrag(e)) return;
      e.preventDefault();
      depth++;
      clearTimeout(settle);
      setDrop('over');
    };
    const over = (e: DragEvent) => {
      if (isPdfDrag(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!isPdfDrag(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDrop('idle');
    };
    const onDrop = (e: DragEvent) => {
      if (!isPdfDrag(e)) return;
      e.preventDefault();
      depth = 0;
      setDropAt({ x: e.clientX, y: e.clientY, key: Date.now() });
      setDrop('dropping');
      clearTimeout(settle);
      settle = setTimeout(() => setDrop('idle'), 750);
      void doUpload(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', onDrop);
    return () => {
      clearTimeout(settle);
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', onDrop);
    };
  }, [doUpload]);

  const remove = async (p: PaperDto) => {
    if (!confirm(`삭제할까요?\n${p.title}\n\nPDF·하이라이트·분석·토론·설명이 모두 지워집니다.`)) return;
    try {
      await api(`/api/papers/${p.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  };

  const dropping = drop === 'dropping';
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 pt-10 pb-16">
        <div className="mb-4 flex items-baseline gap-2">
          <h1 className="text-[20px] font-semibold tracking-tight text-fg">라이브러리</h1>
          {papers && !debouncedQ && <span className="font-mono text-[13px] text-fg-dim">{papers.length}</span>}
        </div>
        <div className="rounded-[22px] border border-line bg-raised px-4 pt-3 pb-2.5 shadow-sm transition-colors duration-150 focus-within:border-line-strong">
          <input
            className="w-full bg-transparent text-[14px] text-fg outline-none placeholder:text-fg-dim"
            placeholder="DOI·arXiv·OpenAlex 링크를 붙여넣거나 PDF를 끌어다 놓으세요"
            aria-label="DOI, arXiv 또는 OpenAlex 링크"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doImport();
            }}
          />
          <div className="mt-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line px-3 text-[12.5px] text-fg-muted transition-[background-color,color,transform] duration-150 hover:bg-hover hover:text-fg active:scale-[0.97]"
                onClick={() => fileRef.current?.click()}
              >
                <FileUp size={14} />
                PDF 선택
              </button>
              <select
                aria-label="분야"
                className="h-8 rounded-lg border border-line bg-surface px-2 text-[12.5px] text-fg"
                value={importField}
                onChange={(e) => {
                  const value = e.target.value;
                  const field = isFieldId(value) ? value : 'auto';
                  setImportField(field);
                  localStorage.setItem('pr.importField', field);
                }}
              >
                <option value="auto">분야 자동 판별</option>
                {FIELDS.map((field) => <option key={field} value={field}>{FIELD_LABELS[field]}</option>)}
              </select>
            </div>
            <button
              className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-inverse text-inverse-fg transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.95] disabled:pointer-events-none disabled:opacity-30"
              aria-label="가져오기"
              disabled={!input.trim()}
              onClick={() => void doImport()}
            >
              {importing ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={16} />}
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (files.length) void doUpload(files);
            }}
          />
        </div>
        <div className="relative mt-6">
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-dim" />
          <input
            className="h-9 w-full rounded-lg bg-transparent pr-3 pl-9 text-[13px] text-fg outline-none transition-colors duration-150 placeholder:text-fg-dim hover:bg-hover focus:bg-sunken"
            placeholder="제목·저자·본문 검색"
            aria-label="라이브러리 검색"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {papers === null ? (
          <p className="mt-6 text-[13px] text-fg-muted">불러오는 중…</p>
        ) : papers.length === 0 ? (
          debouncedQ ? (
            <p className="mt-10 text-center text-[13px] text-fg-muted">검색 결과가 없습니다</p>
          ) : (
            <div className="pr-fade-in mt-16 flex flex-col items-center text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-sunken">
                <FileUp size={18} className="text-fg-muted" />
              </div>
              <p className="mt-3 text-[14px] text-fg">아직 논문이 없습니다</p>
              <p className="mt-1 text-[12.5px] text-fg-muted">PDF를 이 창에 끌어다 놓거나 DOI·arXiv·OpenAlex 링크를 붙여넣으세요.</p>
            </div>
          )
        ) : (
          <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {papers.map((p) => (
              <PaperCard key={p.id} p={p} isNew={newIds.has(p.id)} onDelete={() => void remove(p)} />
            ))}
          </ul>
        )}
      </div>
      {drop !== 'idle' && (
        <div className="pointer-events-none fixed inset-0 z-[80]">
          <div className={`pr-fade-in absolute inset-0 bg-canvas/60 backdrop-blur-[2px] transition-opacity duration-200 ${dropping ? 'opacity-0' : ''}`} />
          <LiquidDrop active={drop === 'over'} dropAt={dropAt} />
          <div className={`absolute inset-0 flex items-center justify-center transition-opacity duration-200 ${dropping ? 'opacity-0' : ''}`}>
            <div className="pr-fade-in flex flex-col items-center rounded-2xl border border-accent/40 bg-raised/90 px-6 py-4 text-center shadow-pop">
              <FileUp size={20} className="text-accent" />
              <p className="mt-2 text-[14px] font-medium text-fg">놓으면 가져옵니다</p>
              <p className="mt-0.5 text-[12px] text-fg-muted">여러 PDF도 한 번에 가져옵니다</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type BadgeTone = 'neutral' | 'success' | 'accent' | 'warning';
const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-sunken text-fg-muted',
  success: 'bg-success-soft text-success',
  accent: 'bg-accent-soft text-accent',
  warning: 'bg-warning-soft text-warning',
};

function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: BadgeTone }) {
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${BADGE_TONES[tone]}`}>{children}</span>;
}

function PaperCard({ p, isNew, onDelete }: { p: PaperDto; isNew: boolean; onDelete(): void }) {
  const toast = useToast();
  const running = p.job && (p.job.status === 'running' || p.job.status === 'queued');
  const tr = p.status.translation;
  const trPct = tr.total ? Math.round((tr.done / tr.total) * 100) : 0;
  const meta = [authorShort(p), p.year, p.journal].filter(Boolean).join(' · ');
  return (
    <li className={`group px-4 py-3 transition-colors duration-150 hover:bg-hover ${isNew ? 'pr-row-new' : ''}`}>
      <div className="flex items-start gap-3">
        <Link href={`/paper/${p.id}`} className="min-w-0 flex-1">
          <div className="text-[14px] leading-snug font-medium text-fg">{p.title}</div>
          {meta && <div className="mt-0.5 truncate text-[12px] text-fg-muted">{meta}</div>}
          <div className="mt-1.5 flex flex-wrap gap-1.5 empty:hidden">
            {p.field ? <Badge>{FIELD_LABELS[p.field]}</Badge> : <Badge tone="warning">분야 확인 필요</Badge>}
            {p.status.analysis && <Badge tone="success">분석</Badge>}
            {tr.done > 0 && (
              <Badge tone="accent">
                번역 <span className="font-mono">{trPct}%</span>
              </Badge>
            )}
            {p.status.mindmap && <Badge>마인드맵</Badge>}
            {!p.hasPdf && !running && <Badge tone="warning">PDF 없음</Badge>}
          </div>
        </Link>
        <button
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-fg-dim opacity-0 transition-[opacity,background-color,color,transform] duration-150 group-hover:opacity-100 hover:bg-danger-soft hover:text-danger focus-visible:opacity-100 active:scale-[0.95]"
          aria-label="삭제"
          title="삭제"
          onClick={onDelete}
        >
          <Trash2 size={15} />
        </button>
      </div>
      {p.job && (running || p.job.status === 'error' || (!p.hasPdf && p.job.message)) && (
        <div className="mt-2">
          {running ? (
            <JobBar
              job={p.job}
              onCancel={() => void api(`/api/jobs/${p.job!.id}/cancel`, { method: 'POST' }).catch((e: Error) => toast(e.message, { tone: 'error' }))}
            />
          ) : (
            <div className={`text-[12px] ${p.job.status === 'error' ? 'text-danger' : 'text-fg-muted'}`}>
              {p.job.status === 'error' ? p.job.error : p.job.message}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
