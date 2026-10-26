import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { JobBar } from '../components/JobBar';
import { Markdown } from '../components/Markdown';
import { useToast } from '../components/Toast';
import { usePaper } from '../state/paper';
import { useJob } from '../state/useJob';
import { RESEARCH_TYPE_LABELS, type ArtifactDto, type ResearchType } from '../types';

const TYPES = Object.keys(RESEARCH_TYPE_LABELS) as ResearchType[];
const isType = (t: unknown): t is ResearchType => typeof t === 'string' && t in RESEARCH_TYPE_LABELS;

interface AnalysisMeta {
  types: ResearchType[];
  callsDone: number;
  engine: string;
}

function readMeta(meta: Record<string, unknown>): AnalysisMeta {
  return {
    types: Array.isArray(meta.types) ? meta.types.filter(isType) : [],
    callsDone: typeof meta.callsDone === 'number' ? meta.callsDone : 3,
    engine: typeof meta.engine === 'string' ? meta.engine : '',
  };
}

/** `####` headings outside code fences, in document order (matches the rendered h4 order). */
function tocOf(md: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence) {
      const m = /^####\s+(.+?)\s*#*\s*$/.exec(line);
      if (m) out.push(m[1].replace(/\[p\.(\d+(?:[–-]\d+)?)\]/g, 'p.$1').replace(/[*_`]/g, '').trim());
    }
  }
  return out;
}

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

type Step = 'idle' | 'classifying' | 'choose';

export function AnalysisPanel() {
  const { paper, reloadPaper } = usePaper();
  const toast = useToast();
  const [artifact, setArtifact] = useState<ArtifactDto | null | undefined>(undefined);
  const [step, setStep] = useState<Step>('idle');
  const [selected, setSelected] = useState<Set<ResearchType>>(new Set());
  const [reason, setReason] = useState('');
  const [starting, setStarting] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const loadArtifact = useCallback(async () => {
    try {
      setArtifact(await api<ArtifactDto>(`/api/papers/${paper.id}/artifacts/analysis`));
    } catch {
      setArtifact(null);
    }
  }, [paper.id]);

  useEffect(() => {
    setArtifact(undefined);
    setStep('idle');
    void loadArtifact();
  }, [loadArtifact]);

  const h = useJob('analysis', {
    onFinish: () => {
      void loadArtifact();
      void reloadPaper();
    },
  });

  const storedTypes = (paper.researchTypes ?? []).filter(isType);

  const openChooser = (types: ResearchType[], why: string) => {
    setSelected(new Set(types));
    setReason(why);
    setStep('choose');
  };

  const beginAnalysis = async () => {
    if (storedTypes.length) return openChooser(storedTypes, '');
    setStep('classifying');
    try {
      const r = await api<{ types: string[]; reason: string }>(`/api/papers/${paper.id}/classify`, { method: 'POST' });
      openChooser(r.types.filter(isType), r.reason);
      void reloadPaper();
    } catch (e) {
      setStep('idle');
      toast((e as Error).message, { tone: 'error' });
    }
  };

  const reanalyze = () => {
    if (!confirm('분석을 다시 할까요? 기존 분석은 새 결과로 바뀝니다.')) return;
    const prev = artifact ? readMeta(artifact.meta).types : [];
    openChooser(storedTypes.length ? storedTypes : prev, '');
  };

  const start = async () => {
    setStarting(true);
    try {
      const { jobId } = await api<{ jobId: string }>(`/api/papers/${paper.id}/analysis`, {
        method: 'POST',
        json: { types: TYPES.filter((t) => selected.has(t)) },
      });
      setStep('idle');
      h.attach(jobId);
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    } finally {
      setStarting(false);
    }
  };

  const content = artifact?.content ?? '';
  const toc = useMemo(() => tocOf(content), [content]);

  if (h.running) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <JobBar job={h.job} onCancel={() => void h.cancel()} />
        {h.text ? <Markdown text={h.text} /> : <div className="text-[13px] text-stone-400">분석 생성 중…</div>}
      </div>
    );
  }

  if (step === 'classifying') {
    return (
      <div className="flex items-center gap-2 p-6 text-[13px] text-stone-600">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-blue-500" />
        연구 유형 판별 중…
      </div>
    );
  }

  if (step === 'choose') {
    return (
      <div className="flex flex-col gap-3 p-4">
        <div className="text-[13px] font-bold text-stone-700">연구 유형</div>
        <div className="flex flex-col gap-1.5">
          {TYPES.map((t) => (
            <label key={t} className="flex items-center gap-2 text-[13px] text-stone-800">
              <input
                type="checkbox"
                checked={selected.has(t)}
                onChange={(e) =>
                  setSelected((s) => {
                    const next = new Set(s);
                    if (e.target.checked) next.add(t);
                    else next.delete(t);
                    return next;
                  })
                }
              />
              {RESEARCH_TYPE_LABELS[t]}
            </label>
          ))}
        </div>
        {reason && <p className="text-[12px] leading-snug text-stone-500">{reason}</p>}
        <div className="flex gap-2">
          <button
            className="rounded bg-blue-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-blue-700 disabled:opacity-40"
            disabled={selected.size === 0 || starting}
            onClick={() => void start()}
          >
            분석 시작
          </button>
          <button className="rounded border border-stone-300 px-3 py-1.5 text-[13px] hover:bg-stone-100" onClick={() => setStep('idle')}>
            취소
          </button>
        </div>
      </div>
    );
  }

  if (artifact === undefined) return null;

  if (!artifact) {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <JobBar job={h.job} onCancel={() => void h.cancel()} />
        <p className="text-[13px] text-stone-500">연구 유형을 판별한 뒤 구조화된 한국어 분석을 만듭니다.</p>
        <button className="rounded bg-blue-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-blue-700" onClick={() => void beginAnalysis()}>
          분석
        </button>
      </div>
    );
  }

  const meta = readMeta(artifact.meta);
  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-stone-200 bg-white/95 px-4 py-2 text-[12px] text-stone-600 backdrop-blur">
        <span>{meta.types.map((t) => RESEARCH_TYPE_LABELS[t]).join(' · ') || '유형 미상'}</span>
        <span className="text-stone-300">|</span>
        <span>{artifact.engine ?? meta.engine}</span>
        <span className="text-stone-300">|</span>
        <span className="tabular-nums">{fmtDate(artifact.updatedAt)}</span>
        <div className="ml-auto flex items-center gap-2">
          {toc.length > 0 && (
            <select
              className="max-w-[180px] rounded border border-stone-300 bg-white px-1.5 py-0.5 text-[12px]"
              value=""
              onChange={(e) => {
                if (e.target.value !== '') bodyRef.current?.querySelectorAll('h4')[Number(e.target.value)]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
              }}
            >
              <option value="">목차</option>
              {toc.map((t, i) => (
                <option key={i} value={i}>
                  {t}
                </option>
              ))}
            </select>
          )}
          <button className="rounded border border-stone-300 px-2 py-0.5 hover:bg-stone-100" onClick={reanalyze}>
            다시 분석
          </button>
        </div>
      </div>
      {meta.callsDone < 3 && (
        <div className="flex flex-col gap-2 px-4 pt-3">
          <JobBar job={h.job} onCancel={() => void h.cancel()} />
          <p className="text-[12px] text-amber-700">분석이 {meta.callsDone}/3 단계까지만 완료되었습니다 — 다시 분석으로 재시도</p>
        </div>
      )}
      <div ref={bodyRef} className="p-4 [&_h4]:scroll-mt-12">
        <Markdown text={content} />
      </div>
    </div>
  );
}
