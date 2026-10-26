import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { api } from '../api';
import { JobBar } from '../components/JobBar';
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
export async function uploadPdfs(files: File[]): Promise<UploadResult[]> {
  const fd = new FormData();
  for (const f of files) fd.append('file', f);
  return api<UploadResult[]>('/api/papers/upload', { method: 'POST', body: fd });
}

const isPdfDrag = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

export function Library() {
  const [papers, setPapers] = useState<PaperDto[] | null>(null);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [input, setInput] = useState('');
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [, navigate] = useLocation();
  const toast = useToast();

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    const list = await api<PaperDto[]>(`/api/papers${debouncedQ ? `?q=${encodeURIComponent(debouncedQ)}` : ''}`);
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
      const r = await api<ImportResult>('/api/papers/import', { method: 'POST', json: { input } });
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
        const results = await uploadPdfs(pdfs);
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
    [load, navigate, toast],
  );

  // Window-wide drag & drop overlay.
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!isPdfDrag(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (isPdfDrag(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!isPdfDrag(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!isPdfDrag(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      void doUpload(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [doUpload]);

  const remove = async (p: PaperDto) => {
    if (!confirm(`삭제할까요?\n${p.title}\n\nPDF·하이라이트·분석·채팅이 모두 지워집니다.`)) return;
    try {
      await api(`/api/papers/${p.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-6">
        <div className="mb-4 flex gap-2">
          <input
            className="flex-1 rounded-md border border-stone-300 bg-white px-3 py-2 text-[14px] outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            placeholder="DOI 또는 arXiv 링크 붙여넣기"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doImport();
            }}
          />
          <button className="rounded-md bg-stone-900 px-4 text-[14px] font-medium text-white hover:bg-stone-700 disabled:opacity-50" disabled={importing || !input.trim()} onClick={() => void doImport()}>
            {importing ? '가져오는 중…' : '가져오기'}
          </button>
          <button className="rounded-md border border-stone-300 bg-white px-4 text-[14px] hover:bg-stone-100" onClick={() => fileRef.current?.click()}>
            PDF 선택
          </button>
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
        <input
          className="mb-4 w-full rounded-md border border-stone-200 bg-white px-3 py-1.5 text-[13px] outline-none focus:border-stone-400"
          placeholder="라이브러리 검색 (제목·저자·본문)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {papers === null ? (
          <div className="text-[13px] text-stone-500">불러오는 중…</div>
        ) : papers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-stone-300 p-10 text-center text-[14px] text-stone-500">
            {debouncedQ ? '검색 결과가 없습니다.' : 'DOI·arXiv 링크를 붙여넣거나 PDF를 끌어다 놓으세요.'}
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {papers.map((p) => (
              <PaperCard key={p.id} p={p} onDelete={() => void remove(p)} />
            ))}
          </ul>
        )}
      </div>
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-[80] flex items-center justify-center bg-blue-500/15 backdrop-blur-[1px]">
          <div className="rounded-xl border-2 border-dashed border-blue-500 bg-white/90 px-10 py-8 text-[16px] font-semibold text-blue-700">PDF를 놓으면 가져옵니다</div>
        </div>
      )}
    </div>
  );
}

function Badge({ children, tone = 'stone' }: { children: ReactNode; tone?: 'stone' | 'green' | 'blue' | 'amber' | 'violet' }) {
  const tones = {
    stone: 'bg-stone-100 text-stone-600',
    green: 'bg-emerald-50 text-emerald-700',
    blue: 'bg-blue-50 text-blue-700',
    amber: 'bg-amber-50 text-amber-700',
    violet: 'bg-violet-50 text-violet-700',
  };
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

function PaperCard({ p, onDelete }: { p: PaperDto; onDelete(): void }) {
  const toast = useToast();
  const running = p.job && (p.job.status === 'running' || p.job.status === 'queued');
  const tr = p.status.translation;
  const trPct = tr.total ? Math.round((tr.done / tr.total) * 100) : 0;
  const meta = [authorShort(p), p.year, p.journal].filter(Boolean).join(' · ');
  return (
    <li className="group rounded-lg border border-stone-200 bg-white px-4 py-3 hover:border-stone-300 hover:shadow-sm">
      <div className="flex items-start gap-3">
        <Link href={`/paper/${p.id}`} className="min-w-0 flex-1">
          <div className="text-[14.5px] font-semibold leading-snug text-stone-900">{p.title}</div>
          {meta && <div className="mt-0.5 truncate text-[12.5px] text-stone-500">{meta}</div>}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {p.status.analysis && <Badge tone="green">분석</Badge>}
            {tr.done > 0 && <Badge tone="blue">번역 {trPct}%</Badge>}
            {p.status.mindmap && <Badge tone="violet">마인드맵</Badge>}
            {!p.hasPdf && !running && <Badge tone="amber">PDF 없음</Badge>}
          </div>
        </Link>
        <button className="shrink-0 rounded px-2 py-1 text-[12px] text-stone-400 opacity-0 hover:bg-red-50 hover:text-red-600 group-hover:opacity-100" onClick={onDelete}>
          삭제
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
            <div className={`text-[12px] ${p.job.status === 'error' ? 'text-red-600' : 'text-stone-500'}`}>
              {p.job.status === 'error' ? p.job.error : p.job.message}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
