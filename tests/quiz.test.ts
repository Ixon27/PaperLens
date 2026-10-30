import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmResult } from '../src/server/llm';
import { appendQuizBatch, parseQuizContent, validateQuizGeneration, type QuizBatch, type QuizBlock, type QuizContent, type QuizResponse } from '../src/shared/quiz';

// Never import the real config (which creates user storage directories) or run a CLI.
vi.mock('../src/server/config', () => ({
  PATHS: { db: ':memory:', prompts: fileURLToPath(new URL('../prompts', import.meta.url)) },
}));
vi.mock('../src/server/llm', () => ({ runLlm: vi.fn(), resolveModel: vi.fn(() => ({ engine: 'codex', model: 'quiz-heavy', effort: 'high' })) }));
vi.mock('../src/server/routes/papers', () => ({
  requirePaper: (id: string) => {
    const paper = getPaper(id);
    if (!paper) throw new HttpError(404, '논문을 찾을 수 없습니다');
    return paper;
  },
}));

import { db, getArtifact, getPaper, putArtifact } from '../src/server/db';
import { cancelJob, getJobRow, subscribeJob, type JobRow } from '../src/server/jobs';
import { runLlm } from '../src/server/llm';
import { readQuiz, startQuiz, writeQuiz } from '../src/server/tasks/quiz';
import { HttpError } from '../src/server/http-error';
import { quizRoutes } from '../src/server/routes/quiz';

const app = new Hono();
app.onError((error, c) => c.json({ error: error.message }, error instanceof HttpError ? error.status : 500));
app.route('/api', quizRoutes);

const quote = 'Experiment 1 measured resonator noise at 10 kelvin using a calibrated sensor.';
const block: QuizBlock = { idx: 3, page: 2, text: `Methods. ${quote} Measurements were repeated.`, isRef: false };
const by = { engine: 'codex' as const, model: 'quiz-heavy', effort: 'high' };
const generated = (prefix = 'first') => ({ questions: Array.from({ length: 10 }, (_, i) => ({ question: `${prefix} question ${i + 1}?`, choices: ['A', 'B', 'C', 'D'], correctIndex: i % 4, explanation: 'The paper describes the calibrated sensor and measurement temperature.', source: { page: 2, quote } })) });

function makeBatch(prefix: string): QuizBatch {
  return { id: prefix, createdAt: '2026-10-30T10:00:00.000Z', by, questions: validateQuizGeneration(generated(prefix), [block]).map((q, i) => ({ id: `${prefix}-${i}`, ...q })) };
}

function finishJob(id: string): Promise<JobRow> {
  const current = getJobRow(id)!;
  if (current.status === 'done' || current.status === 'error') return Promise.resolve(current);
  const { promise, resolve } = Promise.withResolvers<JobRow>();
  subscribeJob(id, (event) => {
    if (event.event === 'done' || event.event === 'error') resolve(getJobRow(id)!);
  });
  return promise;
}

beforeEach(() => {
  db.prepare('DELETE FROM jobs').run();
  db.prepare('DELETE FROM papers').run();
  db.prepare('INSERT INTO papers(id,title,field,page_count,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('paper', 'Resonator measurements', 'physics', 2, '2026-10-30', '2026-10-30');
  db.prepare('INSERT INTO blocks(paper_id,idx,page,text,lines,page_w,page_h) VALUES(?,?,?,?,?,?,?)').run('paper', block.idx, block.page, block.text, '[]', 600, 800);
  vi.mocked(runLlm).mockReset().mockResolvedValue({ text: JSON.stringify(generated()), by });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('quiz generation boundaries and grounded evidence', () => {
  it('accepts exactly ten distinct four-choice questions and locates literal evidence', () => {
    const questions = validateQuizGeneration(generated(), [block]);
    expect(questions).toHaveLength(10);
    expect(questions[0].source).toEqual({ page: 2, quote, blockIdx: 3, start: 9, end: 9 + quote.length });
  });

  it.each([0, 9, 11])('rejects %i questions instead of padding or truncating', (count) => {
    const raw = generated();
    raw.questions = Array.from({ length: count }, (_, i) => ({ ...raw.questions[i % 10], question: `Question ${i}` }));
    expect(() => validateQuizGeneration(raw, [block])).toThrow('정확히 10문항');
  });

  it.each([-1, 4, 1.5, '0', null, NaN])('rejects invalid correct index %s', (correctIndex) => {
    const raw = generated();
    const malformed = { ...raw, questions: raw.questions.map((q, i) => i === 0 ? { ...q, correctIndex } : q) };
    expect(() => validateQuizGeneration(malformed, [block])).toThrow('정답 번호');
  });

  it('rejects missing questions, malformed choices, duplicate choices and blank explanations', () => {
    expect(() => validateQuizGeneration(null, [block])).toThrow();
    for (const choices of [['A', 'B', 'C'], ['A', 'B', 'C', 'D', 'E'], ['Ａ', ' a ', 'C', 'D'], ['A', '', 'C', 'D']]) {
      const raw = generated();
      raw.questions[0].choices = choices;
      expect(() => validateQuizGeneration(raw, [block])).toThrow();
    }
    const raw = generated();
    raw.questions[0].explanation = ' ';
    expect(() => validateQuizGeneration(raw, [block])).toThrow('해설');
  });

  it('deduplicates normalized question strings both within a batch and against all prior batches', () => {
    const raw = generated();
    raw.questions[1].question = ' FIRST   question 1? ';
    expect(() => validateQuizGeneration(raw, [block])).toThrow('중복된 질문');
    expect(() => validateQuizGeneration(generated(), [block], [' FIRST  question 1? '])).toThrow('중복된 질문');
  });

  it('requires the complete quote on the stated non-reference page, never a nearby page or partial match', () => {
    for (const source of [{ page: 1, quote }, { page: 2.5, quote }, { page: 0, quote }, { page: 2, quote: 'Too short' }, { page: 2, quote: `${quote} Invented conclusion.` }, { page: 2, quote: quote.replace('10 kelvin', '20 kelvin') }]) {
      const raw = generated();
      raw.questions[0].source = source;
      expect(() => validateQuizGeneration(raw, [block])).toThrow();
    }
    expect(() => validateQuizGeneration(generated(), [{ ...block, isRef: true }])).toThrow('찾을 수 없습니다');
  });

  it('allows whitespace-only PDF differences while retaining real offsets and punctuation', () => {
    const wrapped = { ...block, text: block.text.replace('noise at', 'noise\n at') };
    const questions = validateQuizGeneration(generated(), [wrapped]);
    const source = questions[0].source;
    expect(wrapped.text.slice(source.start, source.end)).toBe(source.quote);
    expect(source.quote).toContain('noise\n at');
    const raw = generated();
    raw.questions[0].source.quote = 'Energy E = mc^2 (x+y) is conserved.';
    expect(validateQuizGeneration(raw, [block, { ...block, idx: 4, text: raw.questions[0].source.quote }])[0].source.blockIdx).toBe(4);
  });
});

describe('question-only storage and read-boundary migration', () => {
  it('round-trips v2 questions and CLI-default model metadata without answer state', () => {
    const batch = makeBatch('first');
    batch.by = { engine: 'codex', model: '', effort: '' };
    const content: QuizContent = { version: 2, batches: [batch] };
    expect(parseQuizContent(JSON.parse(JSON.stringify(content)))).toEqual(content);
    expect(() => parseQuizContent({ version: 1, batches: [batch] })).toThrow();
  });

  it('migrates v1 on GET, preserving every batch, question, ID and model while removing saved answers', async () => {
    const batches = [makeBatch('first'), makeBatch('second')];
    const legacy = {
      version: 1,
      batches: batches.map((batch) => ({
        ...batch,
        draft: { answers: [1, ...Array(9).fill(null)], updatedAt: '2026-10-30' },
        attempts: [{ id: 'old-attempt', answers: Array(10).fill(0), score: 3, submittedAt: '2026-10-30' }],
      })),
    };
    putArtifact('paper', 'quiz', JSON.stringify(legacy), { version: 1, imported: true }, by);
    const response = await app.request('/api/papers/paper/quiz');
    expect(response.status).toBe(200);
    const expected: QuizContent = { version: 2, batches };
    expect(await response.json()).toEqual({ quiz: expected });
    const artifact = getArtifact('paper', 'quiz')!;
    expect(JSON.parse(artifact.content)).toEqual(expected);
    expect(JSON.parse(artifact.meta)).toEqual({ version: 2, imported: true });
    expect(JSON.parse(artifact.made_by!)).toEqual(by);
    expect(artifact.engine).toBe(by.engine);
    const before = { ...artifact };
    expect(readQuiz('paper')).toEqual(expected);
    expect(getArtifact('paper', 'quiz')).toEqual(before);
    expect(runLlm).not.toHaveBeenCalled();
  });

  it('normalizes a later v1 sync arrival even after v2 has already been read', () => {
    writeQuiz('paper', { version: 2, batches: [makeBatch('first')] });
    expect(readQuiz('paper')!.version).toBe(2);
    const batches = [makeBatch('first'), makeBatch('synced')];
    putArtifact('paper', 'quiz', JSON.stringify({ version: 1, batches: batches.map((batch) => ({ ...batch, draft: null, attempts: [] })) }), { version: 1 }, by);
    expect(readQuiz('paper')).toEqual({ version: 2, batches });
    expect(JSON.parse(getArtifact('paper', 'quiz')!.content)).toEqual({ version: 2, batches });
  });

  it('GET immediately includes every correct index, explanation and exact PDF source without writing answers', async () => {
    const batch = makeBatch('first');
    writeQuiz('paper', { version: 2, batches: [batch] });
    const before = getArtifact('paper', 'quiz');
    const response = await app.request('/api/papers/paper/quiz');
    expect(response.status).toBe(200);
    const result = await response.json() as QuizResponse;
    expect(result.quiz!.batches[0].questions).toEqual(batch.questions);
    expect(result.quiz!.batches[0].questions[0]).toMatchObject({ correctIndex: 0, explanation: batch.questions[0].explanation, source: { page: block.page, blockIdx: block.idx, quote, start: 9, end: 9 + quote.length } });
    expect(getArtifact('paper', 'quiz')).toEqual(before);
    expect(runLlm).not.toHaveBeenCalled();
  });

  it('exposes only the read and generate endpoints, with no answer persistence routes', async () => {
    expect(await (await app.request('/api/papers/paper/quiz')).json()).toEqual({ quiz: null });
    expect((await app.request('/api/papers/missing/quiz')).status).toBe(404);
    for (const [method, path] of [['PUT', 'batches/first/draft'], ['POST', 'batches/first/attempts']]) {
      expect((await app.request(`/api/papers/paper/quiz/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers: Array(10).fill(0) }) })).status).toBe(404);
    }
    expect(getArtifact('paper', 'quiz')).toBeUndefined();
    const response = await app.request('/api/papers/paper/quiz', { method: 'POST' });
    expect(response.status).toBe(200);
    const { jobId } = await response.json() as { jobId: string };
    expect((await finishJob(jobId)).status).toBe('done');
    expect(readQuiz('paper')!.batches[0].questions).toHaveLength(10);
  });

  it('rejects duplicate appends without changing any existing question batch', () => {
    const content: QuizContent = { version: 2, batches: [makeBatch('first')] };
    const before = JSON.stringify(content);
    expect(() => appendQuizBatch(content, { ...makeBatch('first'), id: 'other' })).toThrow('중복');
    expect(JSON.stringify(content)).toBe(before);
  });

  it.each([1, 2])('never overwrites a malformed v%i artifact during reading or generation', (version) => {
    const legacy = { version, batches: [{ ...makeBatch('first'), questions: [] }] };
    putArtifact('paper', 'quiz', JSON.stringify(legacy), { version }, by);
    const before = getArtifact('paper', 'quiz');
    expect(() => readQuiz('paper')).toThrow('기존 기록은 그대로');
    expect(() => startQuiz('paper')).toThrow('기존 기록은 그대로');
    expect(getArtifact('paper', 'quiz')).toEqual(before);
    expect(runLlm).not.toHaveBeenCalled();
  });
});

describe('quiz job persistence without real AI', () => {
  it('appends ten then ten with the configured heavy model and field-grounded prompt', async () => {
    expect((await finishJob(startQuiz('paper'))).status).toBe('done');
    vi.mocked(runLlm).mockResolvedValueOnce({ text: JSON.stringify(generated('second')), by });
    expect((await finishJob(startQuiz('paper'))).status).toBe('done');
    const content = readQuiz('paper')!;
    expect(content.batches.map((b) => b.questions.length)).toEqual([10, 10]);
    expect(content.batches[0].id).not.toBe(content.batches[1].id);
    expect(new Set(content.batches.flatMap((b) => b.questions.map((q) => q.id))).size).toBe(20);
    expect(runLlm).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runLlm).mock.calls[0][0]).toMatchObject({ profile: 'heavy', model: by });
    expect(vi.mocked(runLlm).mock.calls[0][0].system).toContain('<field>');
    expect(vi.mocked(runLlm).mock.calls[0][0].system).toContain(quote);
    expect(vi.mocked(runLlm).mock.calls[1][0].prompt).toContain('first question 1?');
  });

  it('retains additional question batches arriving while generation awaits its result', async () => {
    const first = makeBatch('first');
    writeQuiz('paper', { version: 2, batches: [first] });
    const deferred = Promise.withResolvers<LlmResult>();
    vi.mocked(runLlm).mockReturnValueOnce(deferred.promise);
    const id = startQuiz('paper');
    const synced = makeBatch('synced');
    writeQuiz('paper', appendQuizBatch(readQuiz('paper')!, synced));
    deferred.resolve({ text: JSON.stringify(generated('second')), by });
    expect((await finishJob(id)).status).toBe('done');
    const reloaded = readQuiz('paper')!;
    expect(reloaded.batches.map((batch) => batch.questions.length)).toEqual([10, 10, 10]);
    expect(reloaded.batches.slice(0, 2)).toEqual([first, synced]);
  });

  it.each(['malformed', 'invalid JSON', 'invalid evidence', 'duplicate', 'cli failure'])('retains the exact artifact after %s with no automatic retry', async (failure) => {
    const content: QuizContent = { version: 2, batches: [makeBatch('first')] };
    writeQuiz('paper', content);
    const before = getArtifact('paper', 'quiz');
    if (failure === 'malformed') vi.mocked(runLlm).mockResolvedValueOnce({ text: JSON.stringify({ questions: generated('second').questions.slice(0, 9) }), by });
    if (failure === 'invalid JSON') vi.mocked(runLlm).mockResolvedValueOnce({ text: '{"questions":', by });
    if (failure === 'invalid evidence') {
      const raw = generated('second');
      raw.questions[0].source.page = 1;
      vi.mocked(runLlm).mockResolvedValueOnce({ text: JSON.stringify(raw), by });
    }
    if (failure === 'duplicate') vi.mocked(runLlm).mockResolvedValueOnce({ text: JSON.stringify(generated()), by });
    if (failure === 'cli failure') vi.mocked(runLlm).mockRejectedValueOnce(new Error('fixture CLI failed'));
    expect((await finishJob(startQuiz('paper'))).status).toBe('error');
    expect(getArtifact('paper', 'quiz')).toEqual(before);
    expect(runLlm).toHaveBeenCalledOnce();
  });

  it('coalesces simultaneous generation requests and does not commit a cancelled result', async () => {
    writeQuiz('paper', { version: 2, batches: [makeBatch('first')] });
    const before = getArtifact('paper', 'quiz');
    const deferred = Promise.withResolvers<LlmResult>();
    vi.mocked(runLlm).mockReturnValueOnce(deferred.promise);
    const id = startQuiz('paper');
    expect(startQuiz('paper')).toBe(id);
    expect(runLlm).toHaveBeenCalledOnce();
    expect(cancelJob(id)).toBe(true);
    deferred.resolve({ text: JSON.stringify(generated('second')), by });
    expect(await finishJob(id)).toMatchObject({ status: 'error', error: '취소됨' });
    expect(getArtifact('paper', 'quiz')).toEqual(before);
  });

  it('rejects missing text or unknown stored schemas before spending any AI usage', () => {
    db.prepare('DELETE FROM blocks').run();
    expect(() => startQuiz('paper')).toThrow('PDF 본문이 없습니다');
    expect(runLlm).not.toHaveBeenCalled();
    db.prepare('INSERT INTO blocks(paper_id,idx,page,text,lines,page_w,page_h) VALUES(?,?,?,?,?,?,?)').run('paper', block.idx, block.page, block.text, '[]', 600, 800);
    putArtifact('paper', 'quiz', '{"version":99,"answers":[1]}', {}, by);
    const before = getArtifact('paper', 'quiz');
    expect(() => readQuiz('paper')).toThrow('기존 기록은 그대로');
    expect(() => startQuiz('paper')).toThrow('기존 기록은 그대로');
    expect(getArtifact('paper', 'quiz')).toEqual(before);
    expect(runLlm).not.toHaveBeenCalled();
  });
});
