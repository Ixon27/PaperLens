import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { CircleAlert, FileText, FileUp, LibraryBig, Loader2, Pencil, Search, Trash2, Upload } from 'lucide-react';
import { FIELDS, FIELD_LABELS, isFieldId, type FieldId } from '../../shared/fields';
import { api } from '../api';
import { btnCls, Dialog, Field, inputCls, primaryBtnCls } from '../components/Dialog';
import { JobBar } from '../components/JobBar';
import { LiquidDrop } from '../components/LiquidDrop';
import { useToast } from '../components/Toast';
import type { PaperDto, SyncStatusDto } from '../types';

interface ImportResult {
  paperId: string;
  jobId?: string;
  duplicate?: boolean;
}
interface UploadResult extends Partial<ImportResult> {
  name: string;
  error?: string;
}

type Filter = 'all' | 'unconfirmed' | FieldId;
type Sort = 'recent' | 'added' | 'title';
const SORTS: { id: Sort; label: string }[] = [
  { id: 'recent', label: '최근 열람 순' },
  { id: 'added', label: '최근 추가 순' },
  { id: 'title', label: '제목 순' },
];
const SORT_KEY = 'pr.librarySort';
const isSort = (v: unknown): v is Sort => SORTS.some((s) => s.id === v);

/** The table layout from 1280 px; narrower windows stack each row. */
const ROW_GRID = 'xl:grid xl:grid-cols-[minmax(0,1fr)_150px_150px_88px_140px] xl:items-center xl:gap-4';

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

/** `오늘`, `어제`, `3일 전`, then a calendar date. */
function openedLabel(iso: string | null): string {
  if (!iso) return '열지 않음';
  const d = new Date(iso);
  const today = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(today) - day(d)) / 86_400_000);
  if (days <= 0) return '오늘';
  if (days === 1) return '어제';
  if (days < 7) return `${days}일 전`;
  return d.getFullYear() === today.getFullYear() ? `${d.getMonth() + 1}월 ${d.getDate()}일` : `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}

function filterLabel(filter: Filter): string {
  if (filter === 'all') return '전체 논문';
  if (filter === 'unconfirmed') return '분야 확인 필요';
  return FIELD_LABELS[filter];
}

export function Library() {
  const [papers, setPapers] = useState<PaperDto[] | null>(null);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [input, setInput] = useState('');
  const [importField, setImportField] = useState<FieldId | 'auto'>(() => {
    const stored = localStorage.getItem('pr.importField');
    return isFieldId(stored) ? stored : 'auto';
  });
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>(() => {
    const stored = localStorage.getItem(SORT_KEY);
    return isSort(stored) ? stored : 'recent';
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

  // Other devices' changes arrive through background sync; reload the list when some were applied.
  useEffect(() => {
    let seen: string | null | undefined;
    const check = async () => {
      try {
        const { changedAt } = await api<SyncStatusDto>('/api/sync/status');
        if (seen !== undefined && changedAt !== seen) void load();
        seen = changedAt;
      } catch {
        // Sync status is optional; the list itself still loads.
      }
    };
    void check();
    const t = setInterval(() => void check(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const counts = useMemo(() => {
    const byField = new Map<FieldId, number>();
    let unconfirmed = 0;
    for (const p of papers ?? []) {
      if (p.field) byField.set(p.field, (byField.get(p.field) ?? 0) + 1);
      else unconfirmed++;
    }
    return { byField, unconfirmed };
  }, [papers]);
  // A selected field stays listed even when a search or delete leaves it empty.
  const fieldsShown = FIELDS.filter((f) => counts.byField.has(f) || f === filter);

  const visible = useMemo(() => {
    const list = (papers ?? []).filter((p) => (filter === 'all' ? true : filter === 'unconfirmed' ? p.field === null : p.field === filter));
    // The server already orders by last opened, then by date added.
    if (sort === 'added') return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (sort === 'title') return [...list].sort((a, b) => a.title.localeCompare(b.title, 'ko'));
    return list;
  }, [papers, filter, sort]);

  const chooseSort = (value: string) => {
    if (!isSort(value)) return;
    setSort(value);
    localStorage.setItem(SORT_KEY, value);
  };

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
  const total = papers?.length ?? 0;
  return (
    <div className="flex h-full">
      <aside aria-label="라이브러리 분류" className="hidden w-60 shrink-0 flex-col overflow-y-auto border-r border-line bg-surface px-3 py-5 lg:flex">
        <SideLabel>라이브러리</SideLabel>
        <SideItem label="전체 논문" count={total} active={filter === 'all'} onClick={() => setFilter('all')} icon={<LibraryBig size={16} />} />
        <SideItem
          label="분야 확인 필요"
          count={counts.unconfirmed}
          active={filter === 'unconfirmed'}
          onClick={() => setFilter('unconfirmed')}
          icon={<CircleAlert size={16} />}
        />
        {fieldsShown.length > 0 && (
          <>
            <SideLabel className="mt-6">분야</SideLabel>
            {fieldsShown.map((f) => (
              <SideItem
                key={f}
                label={FIELD_LABELS[f]}
                count={counts.byField.get(f) ?? 0}
                active={filter === f}
                onClick={() => setFilter(f)}
                icon={<span className="h-1.5 w-1.5 rounded-full bg-current" />}
              />
            ))}
          </>
        )}
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1120px] px-8 pt-8 pb-16">
          <header className="mb-6 flex items-end justify-between gap-4">
            <div>
              <h1 className="text-[26px] leading-tight font-bold tracking-tight text-fg">라이브러리</h1>
              <p className="mt-1.5 text-[14px] text-fg-muted">논문을 모으고 번역·요약·분석 결과를 이어서 확인하세요.</p>
            </div>
            {papers && !debouncedQ && (
              <div className="shrink-0 text-[13px] text-fg-muted">
                논문 <b className="font-semibold text-fg">{total}</b>편
              </div>
            )}
          </header>

          <section aria-label="새 논문 가져오기" className="rounded-2xl border border-line bg-surface p-5 shadow-card transition-colors duration-150 focus-within:border-line-strong">
            <div className="flex items-start gap-4">
              <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
                <Upload size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h2 className="text-[15px] font-semibold text-fg">새 논문 가져오기</h2>
                  <span className="text-[12px] text-fg-dim">PDF는 창 어디에나 끌어다 놓아도 됩니다</span>
                </div>
                <p className="mt-0.5 text-[13px] text-fg-muted">DOI·arXiv·OpenAlex 링크를 붙여넣거나 PDF 파일을 선택하세요.</p>
                <div className="mt-3.5 flex flex-wrap items-center gap-2">
                  <input
                    className="h-10 min-w-[240px] flex-1 rounded-lg border border-line-strong bg-surface px-3 text-[13.5px] text-fg outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-fg-dim focus:border-focus focus:ring-2 focus:ring-focus/25"
                    placeholder="예: 10.1038/s41586-020-2649-2 또는 arXiv:1706.03762"
                    aria-label="DOI, arXiv 또는 OpenAlex 링크"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void doImport();
                    }}
                  />
                  <select
                    aria-label="분야"
                    className="h-10 rounded-lg border border-line-strong bg-surface px-2.5 text-[13px] text-fg"
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
                  <button className={`${btnCls} h-10`} onClick={() => fileRef.current?.click()}>
                    <FileUp size={15} />
                    PDF 선택
                  </button>
                  <button className={`${primaryBtnCls} h-10 min-w-[84px]`} aria-label="가져오기" disabled={!input.trim() || importing} onClick={() => void doImport()}>
                    {importing ? <Loader2 size={16} className="animate-spin" /> : '가져오기'}
                  </button>
                </div>
              </div>
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
          </section>

          <section className="mt-9" aria-label="논문 목록">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-[17px] font-semibold text-fg">{filterLabel(filter)}</h2>
                {papers && (
                  <p className="mt-0.5 text-[12.5px] text-fg-muted">
                    {visible.length}편{debouncedQ ? ` · “${debouncedQ}” 검색 결과` : ''}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="분류"
                  className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-fg lg:hidden"
                  value={filter}
                  onChange={(e) => {
                    const v = e.target.value;
                    setFilter(v === 'all' || v === 'unconfirmed' || isFieldId(v) ? v : 'all');
                  }}
                >
                  <option value="all">전체 논문 ({total})</option>
                  <option value="unconfirmed">분야 확인 필요 ({counts.unconfirmed})</option>
                  {fieldsShown.map((f) => <option key={f} value={f}>{FIELD_LABELS[f]} ({counts.byField.get(f) ?? 0})</option>)}
                </select>
                <div className="relative">
                  <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-dim" />
                  <input
                    className="h-9 w-64 rounded-lg border border-line bg-surface pr-3 pl-9 text-[13px] text-fg outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-fg-dim focus:border-focus focus:ring-2 focus:ring-focus/25"
                    placeholder="제목·저자·본문 검색"
                    aria-label="라이브러리 검색"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                  />
                </div>
                <select aria-label="정렬" className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-fg" value={sort} onChange={(e) => chooseSort(e.target.value)}>
                  {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </div>
            </div>

            {papers === null ? (
              <p className="mt-6 text-[13px] text-fg-muted">불러오는 중…</p>
            ) : papers.length === 0 && !debouncedQ ? (
              <div className="pr-fade-in flex flex-col items-center rounded-xl border border-dashed border-line-strong bg-surface px-6 py-14 text-center">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent">
                  <FileUp size={19} />
                </div>
                <p className="mt-3 text-[14.5px] font-medium text-fg">아직 논문이 없습니다</p>
                <p className="mt-1 text-[13px] text-fg-muted">PDF를 이 창에 끌어다 놓거나 위에 DOI·arXiv·OpenAlex 링크를 붙여넣으세요.</p>
              </div>
            ) : visible.length === 0 ? (
              <p className="rounded-xl border border-line bg-surface px-6 py-10 text-center text-[13px] text-fg-muted">
                {debouncedQ ? '검색 결과가 없습니다' : '이 분류에 해당하는 논문이 없습니다'}
              </p>
            ) : (
              <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
                <div aria-hidden="true" className={`hidden border-b border-line bg-sunken/60 px-4 py-2.5 text-[12px] font-medium text-fg-muted ${ROW_GRID}`}>
                  <span>논문</span>
                  <span>분야</span>
                  <span>진행</span>
                  <span>최근 열람</span>
                  <span />
                </div>
                <ul className="divide-y divide-line">
                  {visible.map((p) => (
                    <PaperRow key={p.id} p={p} isNew={newIds.has(p.id)} onDelete={() => void remove(p)} onChanged={() => void load()} />
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>
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

function SideLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`mb-1.5 px-2.5 text-[11.5px] font-semibold tracking-wide text-fg-dim ${className}`}>{children}</div>;
}

function SideItem({ label, count, active, onClick, icon }: { label: string; count: number; active: boolean; onClick(): void; icon: ReactNode }) {
  return (
    <button
      aria-pressed={active}
      onClick={onClick}
      className={`flex h-9 w-full shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] transition-colors duration-150 ${
        active ? 'bg-accent-soft font-semibold text-accent' : 'text-fg-muted hover:bg-hover hover:text-fg'
      }`}
    >
      <span className="grid w-4 shrink-0 place-items-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className={`font-mono text-[12px] ${active ? 'text-accent' : 'text-fg-dim'}`}>{count}</span>
    </button>
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
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[12px] font-medium whitespace-nowrap ${BADGE_TONES[tone]}`}>{children}</span>;
}

function Progress({ p, running }: { p: PaperDto; running: boolean }) {
  const tr = p.status.translation;
  const pct = tr.total ? Math.min(100, Math.round((tr.done / tr.total) * 100)) : 0;
  const label = !p.hasPdf ? (running ? 'PDF 가져오는 중' : 'PDF 없음') : tr.done === 0 ? '번역 전' : pct === 100 ? '번역 완료' : `번역 ${pct}%`;
  return (
    <div className="min-w-[132px]">
      <div className={`text-[12.5px] ${!p.hasPdf && !running ? 'text-warning' : tr.done ? 'text-fg' : 'text-fg-muted'}`}>{label}</div>
      {p.hasPdf && (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-sunken">
          <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
      )}
      {(p.status.analysis || p.status.mindmap) && (
        <div className="mt-1.5 flex gap-1">
          {p.status.analysis && <Badge tone="success">분석</Badge>}
          {p.status.mindmap && <Badge>마인드맵</Badge>}
        </div>
      )}
    </div>
  );
}

function PaperRow({ p, isNew, onDelete, onChanged }: { p: PaperDto; isNew: boolean; onDelete(): void; onChanged(): void }) {
  const toast = useToast();
  const [renaming, setRenaming] = useState(false);
  const running = !!p.job && (p.job.status === 'running' || p.job.status === 'queued');
  const meta = [authorShort(p), p.year, p.journal].filter(Boolean).join(' · ');
  return (
    <li className={`group px-4 py-3.5 transition-colors duration-150 hover:bg-hover ${isNew ? 'pr-row-new' : ''}`}>
      <div className={`flex flex-col gap-3 ${ROW_GRID}`}>
        <Link href={`/paper/${p.id}`} className="flex min-w-0 items-start gap-3 rounded-lg">
          <span
            className={`mt-0.5 grid h-11 w-9 shrink-0 place-items-center rounded-md border ${
              p.hasPdf ? 'border-line bg-sunken text-accent' : 'border-warning/30 bg-warning-soft text-warning'
            }`}
          >
            <FileText size={17} />
          </span>
          <span className="min-w-0">
            <span className="line-clamp-2 text-[14.5px] leading-snug font-semibold text-fg">{p.title}</span>
            {meta && <span className="mt-1 block truncate text-[12.5px] text-fg-muted">{meta}</span>}
          </span>
        </Link>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pl-12 xl:contents">
          <div>{p.field ? <Badge tone="accent">{FIELD_LABELS[p.field]}</Badge> : <Badge tone="warning">분야 확인 필요</Badge>}</div>
          <Progress p={p} running={running} />
          <div className="text-[12.5px] text-fg-muted">
            <span className="xl:hidden">최근 열람 · </span>
            {openedLabel(p.lastOpenedAt)}
          </div>
          <div className="flex items-center gap-1 xl:justify-end">
            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[12.5px] text-fg-muted transition-[background-color,color,transform] duration-150 hover:bg-hover hover:text-fg active:scale-[0.97]"
              aria-label={`${p.title} 이름 변경`}
              onClick={() => setRenaming(true)}
            >
              <Pencil size={13} />
              이름 변경
            </button>
            <button
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-fg-dim opacity-0 transition-[opacity,background-color,color,transform] duration-150 group-hover:opacity-100 hover:bg-danger-soft hover:text-danger focus-visible:opacity-100 active:scale-[0.95]"
              aria-label="삭제"
              title="삭제"
              onClick={onDelete}
            >
              <Trash2 size={15} />
            </button>
          </div>
        </div>
      </div>
      {p.job && (running || p.job.status === 'error' || (!p.hasPdf && p.job.message)) && (
        <div className="mt-2.5 pl-12">
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
      {renaming && <RenamePaperDialog paper={p} onClose={() => setRenaming(false)} onChanged={onChanged} />}
    </li>
  );
}

function RenamePaperDialog({ paper, onClose, onChanged }: { paper: PaperDto; onClose(): void; onChanged(): void }) {
  const [title, setTitle] = useState(paper.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const save = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/api/papers/${paper.id}`, { method: 'PATCH', json: { title } });
      toast('논문 이름을 변경했습니다');
      onClose();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="논문 이름 변경"
      onClose={onClose}
      dismissible={!saving}
      footer={(close) => (
        <>
          <button className={btnCls} disabled={saving} onClick={close}>취소</button>
          <button className={primaryBtnCls} disabled={saving || !title.trim()} onClick={() => void save()}>저장</button>
        </>
      )}
    >
      <Field label="이름" hint="앱에 표시되는 이름만 바뀌며 원본 PDF 파일은 바뀌지 않습니다.">
        <textarea autoFocus className={`${inputCls} h-20 resize-y`} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      {error && <div className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</div>}
    </Dialog>
  );
}
