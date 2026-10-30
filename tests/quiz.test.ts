import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmResult } from '../src/server/llm';
import { appendQuizBatch, gradeQuiz, parseQuizContent, quizResponse, saveQuizDraft, submitQuizAttempt, validateQuizAnswers, validateQuizGeneration, type QuizBatch, type QuizBlock, type QuizContent } from '../src/shared/quiz';

// Never import the real config (which creates user storage directories) or run a CLI.
vi.mock('../src/server/config', () => ({
  PATHS: { db: ':memory:', prompts: fileURLToPath(new URL('../prompts', import.meta.url)) },
}));
vi.mock('../src/server/llm', () => ({ runLlm: vi.fn(), resolveModel: vi.fn(() => ({ engine: 'codex', model: 'quiz-heavy', effort: 'high' })) }));

import { db, getArtifact, putArtifact } from '../src/server/db';
import { cancelJob, getJobRow, subscribeJob, type JobRow } from '../src/server/jobs';
import { runLlm } from '../src/server/llm';
import { readQuiz, startQuiz, writeQuiz } from '../src/server/tasks/quiz';

const quote = 'Experiment 1 measured resonator noise at 10 kelvin using a calibrated sensor.';
const block: QuizBlock = { idx: 3, page: 2, text: `Methods. ${quote} Measurements were repeated.`, isRef: false };
const by = { engine: 'codex' as const, model: 'quiz-heavy', effort: 'high' };
const generated = (prefix = 'first') => ({ questions: Array.from({ length: 10 }, (_, i) => ({ question: `${prefix} question ${i + 1}?`, choices: ['A', 'B', 'C', 'D'], correctIndex: i % 4, explanation: 'The paper describes the calibrated sensor and measurement temperature.', source: { page: 2, quote } })) });

function makeBatch(prefix: string): QuizBatch {
  return { id: prefix, createdAt: '2026-10-30T10:00:00.000Z', by, questions: validateQuizGeneration(generated(prefix), [block]).map((q, i) => ({ id: `${prefix}-${i}`, ...q })), draft: null, attempts: [] };
}

function finishJob(id: string): Promise<JobRow> {
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

describe('answers, grading and retained history', () => {
  it('allows null only in explicit drafts and rejects short, sparse, noninteger or out-of-range answers', () => {
    expect(validateQuizAnswers(Array(10).fill(null), false)).toEqual(Array(10).fill(null));
    for (const answers of [Array(9).fill(0), Array(11).fill(0), Array(10), Array(10).fill(undefined), [4, ...Array(9).fill(0)], [-1, ...Array(9).fill(0)], [1.1, ...Array(9).fill(0)], ['0', ...Array(9).fill(0)]]) {
      expect(() => validateQuizAnswers(answers, false)).toThrow();
    }
    expect(() => validateQuizAnswers(Array(10).fill(null), true)).toThrow();
  });

  it('grades on the server and preserves old submissions through draft saves, appends and reattempts', () => {
    const first = makeBatch('first');
    let content: QuizContent = appendQuizBatch({ version: 1, batches: [] }, first);
    const answers = first.questions.map((q) => q.correctIndex);
    answers[0] = 1;
    expect(gradeQuiz(first.questions, answers).score).toBe(9);
    content = submitQuizAttempt(content, 'first', answers, 'attempt-1', '2026-10-30T11:00:00Z');
    content = saveQuizDraft(content, 'first', [2, ...Array(9).fill(null)], '2026-10-30T12:00:00Z');
    content = appendQuizBatch(content, makeBatch('second'));
    expect(content.batches).toHaveLength(2);
    expect(content.batches[0].attempts[0]).toMatchObject({ id: 'attempt-1', score: 9, answers });
    expect(content.batches[0].draft?.answers[0]).toBe(2);
    content = submitQuizAttempt(content, 'first', first.questions.map((q) => q.correctIndex), 'attempt-2', '2026-10-30T13:00:00Z');
    expect(content.batches[0].attempts.map((a) => a.score)).toEqual([9, 10]);
    expect(content.batches[0].draft).toBeNull();
    expect(parseQuizContent(JSON.parse(JSON.stringify(content)))).toEqual(content);
  });

  it('round-trips the CLI-default Codex model and rejects tampered stored grading', () => {
    const batch = makeBatch('first');
    batch.by = { engine: 'codex', model: '', effort: '' };
    const content = submitQuizAttempt({ version: 1, batches: [batch] }, batch.id, Array(10).fill(0), 'attempt', '2026-10-30');
    expect(parseQuizContent(JSON.parse(JSON.stringify(content))).batches[0].by.model).toBe('');
    const tampered = JSON.parse(JSON.stringify(content));
    tampered.batches[0].attempts[0].score = 10;
    expect(() => parseQuizContent(tampered)).toThrow('채점 결과');
  });

  it('withholds solutions before a submission and returns persisted per-question explanations after grading', () => {
    const batch = makeBatch('first');
    const initial: QuizContent = { version: 1, batches: [batch] };
    const question = quizResponse(initial).quiz!.batches[0].questions[0];
    expect(question).not.toHaveProperty('correctIndex');
    expect(question).not.toHaveProperty('explanation');
    expect(question).not.toHaveProperty('source');
    const graded = submitQuizAttempt(initial, 'first', Array(10).fill(0), 'attempt', '2026-10-30');
    const dto = quizResponse(parseQuizContent(JSON.parse(JSON.stringify(graded)))).quiz!.batches[0];
    expect(dto.attempts[0].results).toHaveLength(10);
    expect(dto.attempts[0]).toMatchObject({ score: 3, total: 10 });
    expect(dto.attempts[0].results[1]).toMatchObject({ selectedIndex: 0, correctIndex: 1, correct: false, explanation: batch.questions[1].explanation, source: batch.questions[1].source });
  });

  it('rejects invalid submissions and duplicate appends without changing the supplied history', () => {
    const content: QuizContent = { version: 1, batches: [makeBatch('first')] };
    const before = JSON.stringify(content);
    expect(() => submitQuizAttempt(content, 'first', Array(10).fill(null), 'bad', 'now')).toThrow();
    expect(() => submitQuizAttempt(content, 'missing', Array(10).fill(0), 'bad', 'now')).toThrow();
    expect(() => appendQuizBatch(content, { ...makeBatch('first'), id: 'other' })).toThrow('중복');
    expect(JSON.stringify(content)).toBe(before);
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

  it('keeps submissions and drafts saved while a generation is awaiting its result', async () => {
    const first = makeBatch('first');
    writeQuiz('paper', { version: 1, batches: [first] });
    const deferred = Promise.withResolvers<LlmResult>();
    vi.mocked(runLlm).mockReturnValueOnce(deferred.promise);
    const id = startQuiz('paper');
    // Generation is blocked in runLlm. These are the same domain operations used by the save routes.
    writeQuiz('paper', submitQuizAttempt(readQuiz('paper')!, first.id, first.questions.map((q) => q.correctIndex), 'during-generation', '2026-10-30T14:00:00Z'));
    writeQuiz('paper', saveQuizDraft(readQuiz('paper')!, first.id, [1, ...Array(9).fill(null)], '2026-10-30T14:01:00Z'));
    deferred.resolve({ text: JSON.stringify(generated('second')), by });
    expect((await finishJob(id)).status).toBe('done');
    const reloaded = readQuiz('paper')!;
    expect(reloaded.batches).toHaveLength(2);
    expect(reloaded.batches[0].attempts[0]).toMatchObject({ id: 'during-generation', score: 10 });
    expect(reloaded.batches[0].draft?.answers).toEqual([1, ...Array(9).fill(null)]);
    expect(quizResponse(reloaded).quiz!.batches[0].attempts[0].results.every((r) => r.correct)).toBe(true);
  });

  it.each(['malformed', 'duplicate', 'cli failure'])('retains the exact artifact after %s with no automatic retry', async (failure) => {
    const first = makeBatch('first');
    const content = submitQuizAttempt({ version: 1, batches: [first] }, first.id, Array(10).fill(0), 'history', '2026-10-30');
    writeQuiz('paper', content);
    const before = getArtifact('paper', 'quiz');
    if (failure === 'malformed') vi.mocked(runLlm).mockResolvedValueOnce({ text: JSON.stringify({ questions: generated('second').questions.slice(0, 9) }), by });
    if (failure === 'duplicate') vi.mocked(runLlm).mockResolvedValueOnce({ text: JSON.stringify(generated()), by });
    if (failure === 'cli failure') vi.mocked(runLlm).mockRejectedValueOnce(new Error('fixture CLI failed'));
    expect((await finishJob(startQuiz('paper'))).status).toBe('error');
    expect(getArtifact('paper', 'quiz')).toEqual(before);
    expect(runLlm).toHaveBeenCalledOnce();
  });

  it('coalesces simultaneous generation requests and does not commit a cancelled result', async () => {
    writeQuiz('paper', { version: 1, batches: [makeBatch('first')] });
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
