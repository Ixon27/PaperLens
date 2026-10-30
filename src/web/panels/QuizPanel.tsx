import { useCallback, useEffect, useState } from 'react';
import { QUIZ_BATCH_SIZE, type QuizAnswers, type QuizBatchDto, type QuizResponse, type QuizSource } from '../../shared/quiz';
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
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
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
    setDirty(false);
    void load();
  }, [load]);
  const job = useJob('quiz', { onFinish: () => void load() });
  const batches = data?.quiz?.batches ?? [];
  const selected = batches.find((b) => b.id === batchId) ?? batches.at(-1);
  // Pin the initial selection so appending a new batch does not discard answers in progress.
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
  const changeBatch = (id: string) => {
    if (saving || (dirty && !confirm('저장하지 않은 답안이 있습니다. 임시 저장하지 않고 다른 묶음으로 이동할까요?'))) return;
    setBatchId(id);
    setDirty(false);
  };
  return <div className="flex min-h-full flex-col">
    <div className="space-y-2 border-b border-line px-3 py-3">
      <h2 className="text-[14px] font-semibold text-fg">논문 이해도 퀴즈</h2>
      <p className="text-[12.5px] text-fg-muted">한 번에 정확히 10문항 · 4지선다 · 정답 1개 · 시간 제한 없음</p>
      <p className="text-[12px] text-fg-dim">연구 목적·방법·결과·해석·한계를 점검합니다. 생성에는 설정한 깊은 작업 모델을 사용하며, 채점과 다시 풀기에는 AI를 쓰지 않습니다.</p>
      <div className="flex flex-wrap items-center gap-2">
        {batches.length > 0 && <label className="flex items-center gap-2 text-[12px] text-fg-muted">문항 묶음
          <select aria-label="퀴즈 묶음" className={`${inputCls} !w-auto`} value={selected?.id ?? ''} disabled={saving} onChange={(e) => changeBatch(e.target.value)}>
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
    {loaded && !selected && !error && hasText && !job.running && <p className="p-4 text-[13px] text-fg-muted">논문 원문에 근거한 10문항을 만듭니다. 새 묶음을 추가해도 이전 문항과 제출 결과는 보관됩니다.</p>}
    {selected && <QuizBatchView key={`${paper.id}:${selected.id}`} batch={selected} onUpdate={setData} onDirty={setDirty} onSaving={setSaving} />}
  </div>;
}

function QuizBatchView({ batch, onUpdate, onDirty, onSaving }: { batch: QuizBatchDto; onUpdate(response: QuizResponse): void; onDirty(dirty: boolean): void; onSaving(saving: boolean): void }) {
  const { paper, blocks } = usePaper();
  const { revealSource, jumpToPage } = useViewer();
  const [answers, setAnswers] = useState<QuizAnswers>(() => batch.draft?.answers ?? Array(QUIZ_BATCH_SIZE).fill(null));
  const [reviewId, setReviewId] = useState<string | null>(() => batch.draft ? null : batch.attempts.at(-1)?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attempt = batch.attempts.find((a) => a.id === reviewId);
  const shownAnswers = attempt?.answers ?? answers;
  const answered = shownAnswers.filter((v) => v !== null).length;
  const markDirty = (value: boolean) => { setDirty(value); onDirty(value); };
  const persist = async (submit: boolean) => {
    setBusy(true);
    onSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await api<QuizResponse>(`/api/papers/${paper.id}/quiz/batches/${batch.id}/${submit ? 'attempts' : 'draft'}`, { method: submit ? 'POST' : 'PUT', json: { answers } });
      onUpdate(response);
      markDirty(false);
      if (submit) setReviewId(response.quiz?.batches.find((b) => b.id === batch.id)?.attempts.at(-1)?.id ?? null);
      setMessage(submit ? '채점 결과를 저장했습니다.' : '임시 답안을 저장했습니다. 다시 열어도 이어서 풀 수 있습니다.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onSaving(false);
    }
  };
  const source = (s: QuizSource) => {
    const block = blocks?.find((b) => b.idx === s.blockIdx && b.page === s.page && b.text.slice(s.start, s.end) === s.quote);
    if (block) revealSource(block, s.start, s.end);
    else jumpToPage(s.page);
  };
  return <div className="space-y-4 p-3">
    <div className="flex flex-wrap items-center gap-2 text-[12px] text-fg-muted">
      <ModelBadge by={batch.by} />
      <span>생성 {batch.createdAt.slice(0, 10)}</span>
      <span>제출 {batch.attempts.length}회</span>
      {batch.attempts.length > 0 && <label className="flex items-center gap-2">제출 기록
        <select aria-label="퀴즈 제출 기록" className={`${inputCls} !w-auto`} value={reviewId ?? 'draft'} disabled={busy} onChange={(e) => {
          if (dirty && !confirm('저장하지 않은 답안이 있습니다. 저장하지 않고 제출 기록을 볼까요?')) return;
          setReviewId(e.target.value === 'draft' ? null : e.target.value);
          setMessage(null);
          setError(null);
        }}>
          <option value="draft">작성 중인 답안</option>
          {batch.attempts.map((a, i) => <option key={a.id} value={a.id}>{i + 1}회 · {a.score}/10점 · {a.submittedAt.slice(0, 16).replace('T', ' ')}</option>)}
        </select>
      </label>}
    </div>
    {attempt ? <div role="status" className="rounded-lg border border-line bg-sunken p-3">
      <p className="text-[16px] font-semibold text-fg">{attempt.score} / {QUIZ_BATCH_SIZE}점 · 정답 {attempt.score}개, 오답 {QUIZ_BATCH_SIZE - attempt.score}개</p>
      <button className={`${smallBtnCls} mt-2`} disabled={busy} onClick={() => {
        if (dirty && !confirm('작성 중인 답안을 비우고 다시 풀까요? 저장된 제출 기록은 유지됩니다.')) return;
        setAnswers(Array(QUIZ_BATCH_SIZE).fill(null));
        setReviewId(null);
        markDirty(true);
        setMessage('같은 10문항을 다시 풉니다. 이전 제출 결과는 그대로 보관됩니다.');
        setError(null);
      }}>AI 없이 다시 풀기</button>
    </div> : <div className="space-y-2">
      <p className="text-[12.5px] text-fg-muted">{answered} / {QUIZ_BATCH_SIZE}문항 선택 · {dirty ? '저장하지 않은 답안' : batch.draft ? '임시 저장된 답안' : '답안을 선택하세요'}</p>
      <div className="flex flex-wrap gap-2">
        <button className={smallBtnCls} disabled={busy} onClick={() => void persist(false)}>{busy ? '저장 중…' : '답안 임시 저장'}</button>
        <button className={primaryBtnCls} disabled={busy || answered !== QUIZ_BATCH_SIZE} onClick={() => void persist(true)}>제출하고 채점</button>
      </div>
      <p className="text-[12px] text-fg-dim">모든 문항을 선택하면 제출할 수 있습니다. 나중에 이어 풀려면 임시 저장하세요.</p>
    </div>}
    {message && <p role="status" className="text-[12.5px] text-fg-muted">{message}</p>}
    {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
    {batch.questions.map((q, index) => {
      const result = attempt?.results.find((r) => r.questionId === q.id);
      return <fieldset key={q.id} className="min-w-0 rounded-lg border border-line bg-surface p-3">
        <legend className="max-w-full px-1 text-[13px] font-semibold text-fg">문항 {index + 1}</legend>
        <Markdown text={q.question} />
        <div className="mt-3 space-y-2">
          {q.choices.map((choice, choiceIndex) => <label key={choiceIndex} className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-[13px] ${result?.correctIndex === choiceIndex ? 'border-accent bg-accent-soft text-fg' : result && result.selectedIndex === choiceIndex ? 'border-danger/40 bg-danger-soft text-fg' : 'border-line text-fg'}`}>
            <input type="radio" name={`quiz-${q.id}`} value={choiceIndex} checked={shownAnswers[index] === choiceIndex} disabled={busy || !!attempt} className="mt-1 accent-accent" onChange={() => {
              setAnswers((previous) => previous.map((v, i) => i === index ? choiceIndex : v));
              markDirty(true);
              setMessage(null);
              setError(null);
            }} />
            <span className="min-w-0 flex-1"><span className="mr-1 text-fg-muted">{choiceIndex + 1}.</span>{choice}{result?.correctIndex === choiceIndex && <strong className="ml-2 text-accent">정답</strong>}{result && !result.correct && result.selectedIndex === choiceIndex && <span className="ml-2 text-danger">선택한 오답</span>}</span>
          </label>)}
        </div>
        {result && <div className="mt-3 space-y-2 border-t border-line pt-3">
          <p className={`text-[13px] font-semibold ${result.correct ? 'text-accent' : 'text-danger'}`}>{result.correct ? '정답입니다' : `오답입니다 · 정답 ${result.correctIndex + 1}번`}</p>
          <Markdown text={result.explanation} />
          <button className={smallBtnCls} onClick={() => source(result.source)}>원문 p.{result.source.page} 보기</button>
          <blockquote className="border-l-2 border-line pl-3 text-[12px] text-fg-muted">{result.source.quote}</blockquote>
        </div>}
      </fieldset>;
    })}
    {!attempt && <button className={primaryBtnCls} disabled={busy || answered !== QUIZ_BATCH_SIZE} onClick={() => void persist(true)}>10문항 제출하고 채점</button>}
  </div>;
}
