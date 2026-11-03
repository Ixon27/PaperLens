import { useCallback, useEffect, useState } from 'react';
import { PRESENTATION_MAX_MINUTES, PRESENTATION_MIN_MINUTES, presentationAnalysisLabel, type PresentationContent, type PresentationResponse, type PresentationSource } from '../../shared/presentation';
import { api } from '../api';
import { AiUsageNotice } from '../components/AiUsageNotice';
import { inputCls, primaryBtnCls, smallBtnCls } from '../components/Dialog';
import { JobBar, Spinner } from '../components/JobBar';
import { Markdown } from '../components/Markdown';
import { ModelBadge } from '../components/ModelBadge';
import { usePaper } from '../state/paper';
import { useJob } from '../state/useJob';
import { useViewer } from '../state/viewer';

export function PresentationPanel() {
  const { paper, blocks } = usePaper();
  const [data, setData] = useState<PresentationResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState('10');
  const [starting, setStarting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await api<PresentationResponse>(`/api/papers/${paper.id}/presentation`, { signal });
      if (signal?.aborted) return;
      setData(response);
      setLoadError(null);
    } catch (e) {
      if (!signal?.aborted) setLoadError((e as Error).message);
    } finally {
      if (!signal?.aborted) setLoaded(true);
    }
  }, [paper.id]);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setLoaded(false);
    setLoadError(null);
    setError(null);
    setDuration('10');
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const job = useJob('presentation', { onFinish: () => void load() });
  const content = data?.presentation;
  const minutes = Number(duration);
  const validDuration = duration.trim() !== '' && Number.isInteger(minutes) && minutes >= PRESENTATION_MIN_MINUTES && minutes <= PRESENTATION_MAX_MINUTES;
  const hasText = blocks?.some((b) => !b.isRef && b.kind !== 'aside' && b.text.replace(/\s/g, '').length >= 12) ?? false;
  const generate = async () => {
    if (!validDuration) return;
    setStarting(true);
    setError(null);
    try {
      const { jobId } = await api<{ jobId: string }>(`/api/papers/${paper.id}/presentation`, { method: 'POST', json: { durationMinutes: minutes } });
      job.attach(jobId);
    } catch (e) { setError((e as Error).message); }
    finally { setStarting(false); }
  };
  const download = async () => {
    setExporting(true);
    setError(null);
    try {
      const response = await fetch(`/api/papers/${paper.id}/presentation/export`);
      if (!response.ok) {
        let message = `내보내기 실패 (${response.status})`;
        try { const body = await response.json() as { error?: string }; if (body.error) message = body.error; } catch { /* Keep the HTTP error. */ }
        throw new Error(message);
      }
      const blob = await response.blob();
      if (!blob.size) throw new Error('내보낸 파일이 비어 있습니다');
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('Content-Disposition') ?? '')?.[1];
      anchor.download = encoded ? decodeURIComponent(encoded) : 'PaperLens-presentation.md';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError((e as Error).message); }
    finally { setExporting(false); }
  };
  return <div className="flex min-h-full flex-col">
    <div className="space-y-2 border-b border-line px-3 py-3">
      <h2 className="text-[14px] font-semibold text-fg">논문 발표 준비</h2>
      <p className="text-[12.5px] text-fg-muted">발표 시간에 맞춘 슬라이드 개요·발표 대본·예상 질문을 만듭니다. 질의응답 시간은 별도입니다. PPTX는 만들지 않습니다.</p>
      <p className="text-[12px] text-fg-dim">논문 원문과 이미 저장된 분석만 사용하며 Deep Research를 새로 실행하지 않습니다. 생성에 성공하면 자동 저장되고, 동기화가 켜져 있으면 논문과 함께 동기화됩니다. 다시 만들면 이전 발표 자료를 교체합니다.</p>
      {data && <p className="text-[12px] text-fg-muted">이번 생성에 사용할 자료: {presentationAnalysisLabel(data.analysis)}</p>}
      <AiUsageNotice profile="heavy" requests={1} detail="개요·대본·예상 질문을 한 번에 요청합니다. 저장된 자료 보기와 Markdown 내보내기는 AI를 쓰지 않습니다." />
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-[12px] text-fg-muted">발표 시간 (분)
          <input aria-label="발표 시간 (분)" type="number" min={PRESENTATION_MIN_MINUTES} max={PRESENTATION_MAX_MINUTES} step={1} className={`${inputCls} !w-24`} value={duration} disabled={starting || job.running} onChange={(e) => setDuration(e.target.value)} aria-invalid={!validDuration} />
        </label>
        <button className={primaryBtnCls} disabled={!loaded || !job.loaded || !hasText || !validDuration || starting || job.running || !!loadError} onClick={() => void generate()}>{starting ? '요청 중…' : content ? '발표 자료 다시 만들기' : '발표 자료 만들기'}</button>
        {content && <button className={smallBtnCls} disabled={exporting} onClick={() => void download()}>{exporting ? '내보내는 중…' : '저장된 자료 Markdown 내보내기'}</button>}
      </div>
      {!validDuration && <p role="alert" className="text-[12px] text-danger">발표 시간은 {PRESENTATION_MIN_MINUTES}~{PRESENTATION_MAX_MINUTES}분 사이의 정수로 입력하세요.</p>}
      <JobBar job={job.job} onCancel={() => void job.cancel()} label="발표 자료 생성 중…" />
      {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
    </div>
    {!loaded && <div className="p-3"><Spinner text="발표 자료 불러오는 중…" /></div>}
    {loadError && <div role="alert" className="p-3 text-[13px] text-danger">{loadError} <button className={smallBtnCls} onClick={() => void load()}>다시 불러오기</button></div>}
    {loaded && !hasText && <p className="p-3 text-[13px] text-fg-muted">발표 자료를 만들 PDF 본문이 없습니다. 본문을 불러온 뒤 다시 시도하세요.</p>}
    {loaded && !content && !loadError && hasText && !job.running && <p className="p-4 text-[13px] text-fg-muted">발표 시간을 정해 시작하세요. 저장된 분석이 없거나 일부만 있어도 원문에 근거해 만들며 사용한 분석 상태를 기록합니다.</p>}
    {content && <PresentationView content={content} />}
  </div>;
}

function PresentationView({ content }: { content: PresentationContent }) {
  let elapsed = 0;
  return <div className="space-y-4 p-3">
    <header className="space-y-2">
      <h3 className="text-[15px] font-semibold text-fg">{content.title}</h3>
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-fg-muted"><ModelBadge by={content.by} /><span>{content.durationMinutes}분 · {content.slides.length}개 슬라이드 · 생성 {content.createdAt.slice(0, 10)}</span></div>
      <p className="text-[12px] text-fg-muted">생성 당시: {presentationAnalysisLabel(content.analysis)}{content.analysis.updatedAt && ` · 분석 저장 ${content.analysis.updatedAt.slice(0, 10)}`}</p>
      <p className="text-[12px] text-fg-dim">시간 배분은 계획이며 실제 낭독 시간은 리허설로 확인하세요. 대본을 펼쳐 읽고, 근거 버튼으로 PDF를 확인할 수 있습니다.</p>
    </header>
    {content.slides.map((slide, i) => {
      const start = elapsed;
      elapsed += slide.seconds;
      return <section key={i} className="space-y-3 rounded-lg border border-line bg-surface p-3">
        <h4 className="text-[14px] font-semibold text-fg">{i + 1}. {slide.title}</h4>
        <p className="text-[12px] text-fg-muted">{Math.floor(start / 60)}:{String(start % 60).padStart(2, '0')}–{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')} · {slide.seconds}초</p>
        <ul className="list-disc space-y-1 pl-5 text-[13px] text-fg">{slide.bullets.map((bullet, index) => <li key={index}>{bullet}</li>)}</ul>
        <details className="text-[13px] text-fg"><summary className="cursor-pointer font-medium">발표 대본 펼치기</summary><div className="mt-2"><Markdown text={slide.script} /></div></details>
        <PresentationSources sources={slide.sources} />
      </section>;
    })}
    <section className="space-y-3">
      <h3 className="text-[14px] font-semibold text-fg">예상 질문과 답변 (발표 시간에 포함되지 않음)</h3>
      {content.questions.map((q, i) => <details key={i} className="rounded-lg border border-line bg-surface p-3 text-[13px] text-fg"><summary className="cursor-pointer font-medium">{i + 1}. {q.question}</summary><div className="mt-3 space-y-3"><Markdown text={q.answer} /><PresentationSources sources={q.sources} /></div></details>)}
    </section>
  </div>;
}

function PresentationSources({ sources }: { sources: PresentationSource[] }) {
  const { blocks } = usePaper();
  const { revealSource, jumpToPage } = useViewer();
  return <details className="text-[12px] text-fg-muted"><summary className="cursor-pointer">원문 근거 ({sources.length})</summary><div className="mt-2 space-y-2">{sources.map((source, index) => <div key={index} className="space-y-1">
    <button className={smallBtnCls} onClick={() => {
      const block = blocks?.find((b) => b.idx === source.blockIdx && b.page === source.page && b.text.slice(source.start, source.end) === source.quote);
      if (block) revealSource(block, source.start, source.end);
      else jumpToPage(source.page);
    }}>원문 p.{source.page} 보기</button>
    <blockquote className="whitespace-pre-wrap border-l-2 border-line pl-3">{source.quote}</blockquote>
  </div>)}</div></details>;
}
