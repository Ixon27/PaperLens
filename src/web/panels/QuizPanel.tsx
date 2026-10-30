import { useCallback, useEffect, useState } from 'react';
import { QUIZ_BATCH_SIZE, type QuizBatch, type QuizResponse, type QuizSource } from '../../shared/quiz';
import { api } from '../api';
import { inputCls, primaryBtnCls, smallBtnCls } from '../components/Dialog';
import { JobBar, Spinner } from '../components/JobBar';
import { Markdown } from '../components/Markdown';
import { ModelBadge } from '../components/ModelBadge';
import { usePaper } from '../state/paper';
import { useJob } from '../state/useJob';
import { useViewer } from '../state/viewer';

export function QuizPanel() {
  const { paper, blocks } = usePaper();
  const [data, setData] = useState<QuizResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [starting, setStarting] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const response = await api<QuizResponse>(`/api/papers/${paper.id}/quiz`);
      setData(response);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [paper.id]);
  useEffect(() => {
    setData(null);
    setLoaded(false);
    setError(null);
    setBatchId(null);
    void load();
  }, [load]);
  const job = useJob('quiz', { onFinish: () => void load() });
  const batches = data?.quiz?.batches ?? [];
  const selected = batches.find((b) => b.id === batchId) ?? batches.at(-1);
  // Keep the current questions and local choices visible while adding another batch.
  useEffect(() => { if (selected && batchId === null) setBatchId(selected.id); }, [selected, batchId]);
  const hasText = blocks?.some((b) => !b.isRef && b.text.replace(/\s/g, '').length >= 12) ?? false;
  const generate = async () => {
    setStarting(true);
    setError(null);
    try {
      const { jobId } = await api<{ jobId: string }>(`/api/papers/${paper.id}/quiz`, { method: 'POST' });
      job.attach(jobId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };
  return <div className="flex min-h-full flex-col">
    <div className="space-y-2 border-b border-line px-3 py-3">
      <h2 className="text-[14px] font-semibold text-fg">논문 이해도 퀴즈</h2>
      <p className="text-[12.5px] text-fg-muted">한 번에 정확히 10문항 · 4지선다 · 정답 1개 · 시간 제한 없음</p>
      <p className="text-[12px] text-fg-dim">보기를 고르면 정답·해설·원문 근거를 바로 확인합니다. 생성에는 설정한 깊은 작업 모델을 사용하며, 정답 확인과 다시 풀기에는 AI를 쓰지 않습니다. 선택한 답은 저장하지 않습니다.</p>
      <div className="flex flex-wrap items-center gap-2">
        {batches.length > 0 && <label className="flex items-center gap-2 text-[12px] text-fg-muted">문항 묶음
          <select aria-label="퀴즈 묶음" className={`${inputCls} !w-auto`} value={selected?.id ?? ''} onChange={(e) => setBatchId(e.target.value)}>
            {batches.map((b, i) => <option key={b.id} value={b.id}>{i + 1}차 · 10문항 · {b.createdAt.slice(0, 10)}</option>)}
          </select>
        </label>}
        <button className={batches.length ? smallBtnCls : primaryBtnCls} disabled={!loaded || !job.loaded || !hasText || starting || job.running || !!error} onClick={() => void generate()}>
          {starting ? '요청 중…' : batches.length ? '추가 10문항 만들기' : '10문항 만들기'}
        </button>
        {batches.length > 0 && <span className="text-[12px] text-fg-muted">누적 {batches.length * QUIZ_BATCH_SIZE}문항</span>}
      </div>
      <JobBar job={job.job} onCancel={() => void job.cancel()} label="퀴즈 10문항 생성 중…" />
    </div>
    {!loaded && <div className="p-3"><Spinner text="퀴즈 불러오는 중…" /></div>}
    {error && <div role="alert" className="p-3 text-[13px] text-danger">{error} <button className={smallBtnCls} onClick={() => void load()}>다시 불러오기</button></div>}
    {loaded && !hasText && <p className="p-3 text-[13px] text-fg-muted">퀴즈를 만들 PDF 본문이 없습니다. 본문을 불러온 뒤 다시 시도하세요.</p>}
    {loaded && !selected && !error && hasText && !job.running && <p className="p-4 text-[13px] text-fg-muted">논문 원문에 근거한 10문항을 만듭니다. 새 묶음을 추가해도 이전 문항은 보관됩니다.</p>}
    {selected && <QuizBatchView key={`${paper.id}:${selected.id}`} batch={selected} />}
  </div>;
}

function QuizBatchView({ batch }: { batch: QuizBatch }) {
  const { blocks } = usePaper();
  const { revealSource, jumpToPage } = useViewer();
  const [answers, setAnswers] = useState<(number | null)[]>(() => Array(batch.questions.length).fill(null));
  const answered = answers.filter((v) => v !== null).length;
  const source = (s: QuizSource) => {
    const block = blocks?.find((b) => b.idx === s.blockIdx && b.page === s.page && b.text.slice(s.start, s.end) === s.quote);
    if (block) revealSource(block, s.start, s.end);
    else jumpToPage(s.page);
  };
  return <div className="space-y-4 p-3">
    <div className="flex flex-wrap items-center gap-2 text-[12px] text-fg-muted">
      <ModelBadge by={batch.by} />
      <span>생성 {batch.createdAt.slice(0, 10)}</span>
      <span>{answered} / {QUIZ_BATCH_SIZE}문항 선택</span>
      <button className={smallBtnCls} disabled={answered === 0} onClick={() => setAnswers(Array(batch.questions.length).fill(null))}>AI 없이 다시 풀기</button>
    </div>
    {batch.questions.map((q, index) => {
      const selectedIndex = answers[index];
      const revealed = selectedIndex !== null;
      const correct = selectedIndex === q.correctIndex;
      return <fieldset key={q.id} className="min-w-0 rounded-lg border border-line bg-surface p-3">
        <legend className="max-w-full px-1 text-[13px] font-semibold text-fg">문항 {index + 1}</legend>
        <Markdown text={q.question} />
        <div className="mt-3 space-y-2">
          {q.choices.map((choice, choiceIndex) => <label key={choiceIndex} className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-[13px] ${revealed && q.correctIndex === choiceIndex ? 'border-accent bg-accent-soft text-fg' : revealed && selectedIndex === choiceIndex ? 'border-danger/40 bg-danger-soft text-fg' : 'border-line text-fg'}`}>
            <input type="radio" name={`quiz-${q.id}`} value={choiceIndex} checked={selectedIndex === choiceIndex} className="mt-1 accent-accent" onChange={() => setAnswers((previous) => previous.map((v, i) => i === index ? choiceIndex : v))} />
            <span className="min-w-0 flex-1"><span className="mr-1 text-fg-muted">{choiceIndex + 1}.</span>{choice}{revealed && q.correctIndex === choiceIndex && <strong className="ml-2 text-accent">정답</strong>}{revealed && !correct && selectedIndex === choiceIndex && <span className="ml-2 text-danger">선택한 오답</span>}</span>
          </label>)}
        </div>
        {revealed && <div className="mt-3 space-y-2 border-t border-line pt-3">
          <p role="status" className={`text-[13px] font-semibold ${correct ? 'text-accent' : 'text-danger'}`}>{correct ? '정답입니다' : '오답입니다'} · 정답 {q.correctIndex + 1}번: {q.choices[q.correctIndex]}</p>
          <Markdown text={q.explanation} />
          <button className={smallBtnCls} onClick={() => source(q.source)}>원문 p.{q.source.page} 보기</button>
          <blockquote className="border-l-2 border-line pl-3 text-[12px] text-fg-muted">{q.source.quote}</blockquote>
        </div>}
      </fieldset>;
    })}
  </div>;
}
