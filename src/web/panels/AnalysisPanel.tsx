import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { btnCls, primaryBtnCls, smallGhostBtnCls } from '../components/Dialog';
import { JobBar, Spinner } from '../components/JobBar';
import { Markdown } from '../components/Markdown';
import { ModelBadge } from '../components/ModelBadge';
import { SectionedMarkdown } from '../components/SectionedMarkdown';
import { useToast } from '../components/Toast';
import { usePaper } from '../state/paper';
import { useArtifact } from '../state/useArtifact';
import { useJob } from '../state/useJob';
import { RESEARCH_TYPE_LABELS, type ResearchType } from '../types';
import type { MadeBy } from '../../shared/models';

const TYPES = Object.keys(RESEARCH_TYPE_LABELS) as ResearchType[];
const isType = (t: unknown): t is ResearchType => typeof t === 'string' && t in RESEARCH_TYPE_LABELS;
const isEngine = (v: unknown): v is MadeBy['engine'] => v === 'claude' || v === 'codex';

interface AnalysisMeta {
  types: ResearchType[];
  callsDone: number;
  by: MadeBy | null;
}

function readMeta(meta: Record<string, unknown>): AnalysisMeta {
  const by = meta.by as MadeBy | undefined;
  return {
    types: Array.isArray(meta.types) ? meta.types.filter(isType) : [],
    callsDone: typeof meta.callsDone === 'number' ? meta.callsDone : 3,
    // Older analyses stored only `engine` in meta.
    by: by && isEngine(by.engine) ? by : isEngine(meta.engine) ? { engine: meta.engine } : null,
  };
}

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function Card({ title, meta, actions, children }: { title: string; meta?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-canvas/60 p-3">
      <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 px-1 pb-2.5 text-[12px] text-fg-muted">
        <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
        {meta}
        <div className="ml-auto flex items-center gap-1">{actions}</div>
      </div>
      {children}
    </section>
  );
}

export function AnalysisPanel() {
  return (
    <div className="p-4">
      <DeepAnalysisCard />
    </div>
  );
}

type Step = 'idle' | 'classifying' | 'choose';

function DeepAnalysisCard() {
  const { paper, reloadPaper } = usePaper();
  const toast = useToast();
  const { artifact, load } = useArtifact(paper.id, 'analysis');
  const [step, setStep] = useState<Step>('idle');
  const [selected, setSelected] = useState<Set<ResearchType>>(new Set());
  const [reason, setReason] = useState('');
  const [starting, setStarting] = useState(false);

  useEffect(() => setStep('idle'), [paper.id]);

  const h = useJob('analysis', {
    onFinish: () => {
      void load();
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

  const meta = artifact ? readMeta(artifact.meta) : null;
  let body: ReactNode;
  if (h.running) {
    body = (
      <div className="flex flex-col gap-3 px-1">
        <JobBar job={h.job} onCancel={() => void h.cancel()} />
        {h.text ? <Markdown text={h.text} /> : <Spinner text="분석 작성 중…" />}
      </div>
    );
  } else if (step === 'classifying') {
    body = <Spinner text="연구 유형 판별 중…" />;
  } else if (step === 'choose') {
    body = (
      <div className="flex flex-col gap-3 px-1">
        <div className="text-[13px] font-semibold text-fg">연구 유형</div>
        <div className="flex flex-col gap-1.5">
          {TYPES.map((t) => (
            <label key={t} className="flex items-center gap-2 text-[13px] text-fg">
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
        {reason && <p className="text-[12px] leading-snug text-fg-muted">{reason}</p>}
        <div className="flex gap-2">
          <button className={primaryBtnCls} disabled={selected.size === 0 || starting} onClick={() => void start()}>
            분석 시작
          </button>
          <button className={btnCls} onClick={() => setStep('idle')}>
            취소
          </button>
        </div>
      </div>
    );
  } else if (artifact === undefined) {
    body = null;
  } else if (!artifact) {
    body = (
      <div className="flex flex-col items-start gap-3 px-1">
        <JobBar job={h.job} onCancel={() => void h.cancel()} />
        <p className="text-[13px] leading-relaxed text-fg-muted">Methods·Results·Discussion까지 자세히 풀어 씁니다. 세 부분을 동시에 작성해 몇 분 걸립니다.</p>
        <button className={primaryBtnCls} onClick={() => void beginAnalysis()}>
          심층 분석 시작
        </button>
      </div>
    );
  } else {
    body = (
      <>
        {meta && meta.callsDone < 3 && (
          <div className="mb-3 flex flex-col gap-2 px-1">
            <JobBar job={h.job} onCancel={() => void h.cancel()} />
            <p className="text-[12px] text-warning">분석이 {meta.callsDone}/3부분만 완료됐습니다. 다시 분석해 주세요.</p>
          </div>
        )}
        <SectionedMarkdown text={artifact.content} nav />
      </>
    );
  }

  return (
    <Card
      title="심층 분석"
      meta={
        artifact &&
        meta && (
          <>
            <span>{meta.types.map((t) => RESEARCH_TYPE_LABELS[t]).join(' · ') || '유형 미상'}</span>
            <ModelBadge by={artifact.by ?? meta.by} />
            <span className="tabular-nums text-fg-dim">{fmtDate(artifact.updatedAt)}</span>
          </>
        )
      }
      actions={
        artifact &&
        !h.running &&
        step === 'idle' && (
          <button className={smallGhostBtnCls} onClick={reanalyze}>
            다시 분석
          </button>
        )
      }
    >
      {body}
    </Card>
  );
}
