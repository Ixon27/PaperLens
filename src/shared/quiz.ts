import type { MadeBy } from './models';

export const QUIZ_BATCH_SIZE = 10;
export type QuizAnswers = (number | null)[];

export interface QuizSource {
  page: number;
  quote: string;
  blockIdx: number;
  start: number;
  end: number;
}

export interface QuizQuestion {
  id: string;
  question: string;
  choices: [string, string, string, string];
  correctIndex: number;
  explanation: string;
  source: QuizSource;
}

export interface QuizAttempt {
  id: string;
  submittedAt: string;
  answers: number[];
  score: number;
}

export interface QuizBatch {
  id: string;
  createdAt: string;
  by: MadeBy;
  questions: QuizQuestion[];
  draft: { answers: QuizAnswers; updatedAt: string } | null;
  attempts: QuizAttempt[];
}

export interface QuizContent {
  version: 1;
  batches: QuizBatch[];
}

export interface QuizResult {
  questionId: string;
  selectedIndex: number;
  correctIndex: number;
  correct: boolean;
  explanation: string;
  source: QuizSource;
}

export interface QuizBatchDto extends Omit<QuizBatch, 'questions' | 'attempts'> {
  questions: Pick<QuizQuestion, 'id' | 'question' | 'choices'>[];
  attempts: (QuizAttempt & { total: number; results: QuizResult[] })[];
}

export interface QuizResponse {
  quiz: { version: 1; batches: QuizBatchDto[] } | null;
}

export interface QuizBlock {
  idx: number;
  page: number;
  text: string;
  isRef: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const key = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const text = (v: unknown, name: string, max: number): string => {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max) throw new Error(`${name} 형식이 올바르지 않습니다`);
  return v.trim();
};
const choiceIndex = (v: unknown): v is number => Number.isInteger(v) && typeof v === 'number' && v >= 0 && v < 4;

function questionFields(raw: unknown): Omit<QuizQuestion, 'id' | 'source'> {
  if (!isObject(raw)) throw new Error('문항 형식이 올바르지 않습니다');
  const question = text(raw.question, '질문', 1500);
  if (!Array.isArray(raw.choices) || raw.choices.length !== 4) throw new Error('보기는 정확히 4개여야 합니다');
  const choices = raw.choices.map((v) => text(v, '보기', 1500)) as QuizQuestion['choices'];
  if (new Set(choices.map(key)).size !== 4) throw new Error('중복된 보기가 있습니다');
  if (!choiceIndex(raw.correctIndex)) throw new Error('정답 번호는 0~3의 정수여야 합니다');
  return { question, choices, correctIndex: raw.correctIndex, explanation: text(raw.explanation, '해설', 5000) };
}

/** Full, literal quote match on the stated page; only whitespace differences are allowed. */
function validateSource(raw: unknown, blocks: QuizBlock[]): QuizSource {
  if (!isObject(raw) || !Number.isInteger(raw.page) || typeof raw.page !== 'number' || raw.page < 1) throw new Error('근거 페이지가 올바르지 않습니다');
  const quote = text(raw.quote, '근거 인용문', 2000);
  if (quote.replace(/\s/g, '').length < 12) throw new Error('근거 인용문은 공백을 제외하고 12자 이상이어야 합니다');
  const pattern = new RegExp(quote.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'u');
  for (const block of blocks) {
    if (block.isRef || block.page !== raw.page) continue;
    const match = pattern.exec(block.text);
    if (match) return { page: raw.page, quote: match[0], blockIdx: block.idx, start: match.index, end: match.index + match[0].length };
  }
  throw new Error(`p.${raw.page} 본문에서 근거 인용문을 찾을 수 없습니다`);
}

/** Reject the whole response rather than silently dropping, padding, or regenerating questions. */
export function validateQuizGeneration(raw: unknown, blocks: QuizBlock[], existing: readonly string[] = []): Omit<QuizQuestion, 'id'>[] {
  if (!isObject(raw) || !Array.isArray(raw.questions) || raw.questions.length !== QUIZ_BATCH_SIZE) throw new Error('퀴즈는 한 번에 정확히 10문항이어야 합니다');
  const seen = new Set(existing.map(key));
  return raw.questions.map((value) => {
    const fields = questionFields(value);
    const normalized = key(fields.question);
    if (seen.has(normalized)) throw new Error('이미 있거나 중복된 질문이 있습니다');
    seen.add(normalized);
    return { ...fields, source: validateSource((value as Record<string, unknown>).source, blocks) };
  });
}

export function validateQuizAnswers(raw: unknown, complete: boolean): QuizAnswers {
  if (!Array.isArray(raw) || raw.length !== QUIZ_BATCH_SIZE || Array.from(raw).some((v) => !choiceIndex(v) && !(v === null && !complete))) {
    throw new Error(complete ? '10문항 모두 0~3의 보기 번호로 답하세요' : '답안은 보기 번호(0~3) 또는 null인 10개 항목이어야 합니다');
  }
  return [...raw] as QuizAnswers;
}

export function gradeQuiz(questions: QuizQuestion[], raw: unknown): { answers: number[]; score: number } {
  if (questions.length !== QUIZ_BATCH_SIZE) throw new Error('채점할 퀴즈는 정확히 10문항이어야 합니다');
  const answers = validateQuizAnswers(raw, true) as number[];
  return { answers, score: questions.reduce((sum, q, i) => sum + Number(q.correctIndex === answers[i]), 0) };
}

export function appendQuizBatch(content: QuizContent, batch: QuizBatch): QuizContent {
  const seen = new Set(content.batches.flatMap((b) => b.questions.map((q) => key(q.question))));
  if (batch.questions.length !== QUIZ_BATCH_SIZE || content.batches.some((b) => b.id === batch.id)) throw new Error('새 퀴즈 묶음이 올바르지 않습니다');
  for (const q of batch.questions) {
    if (seen.has(key(q.question))) throw new Error('이미 있거나 중복된 질문이 있습니다');
    seen.add(key(q.question));
  }
  return { version: 1, batches: [...content.batches, batch] };
}

export function saveQuizDraft(content: QuizContent, batchId: string, raw: unknown, updatedAt: string): QuizContent {
  const answers = validateQuizAnswers(raw, false);
  if (!content.batches.some((b) => b.id === batchId)) throw new Error('퀴즈 묶음을 찾을 수 없습니다');
  return { ...content, batches: content.batches.map((b) => b.id === batchId ? { ...b, draft: { answers, updatedAt } } : b) };
}

export function submitQuizAttempt(content: QuizContent, batchId: string, raw: unknown, id: string, submittedAt: string): QuizContent {
  const batch = content.batches.find((b) => b.id === batchId);
  if (!batch) throw new Error('퀴즈 묶음을 찾을 수 없습니다');
  const graded = gradeQuiz(batch.questions, raw);
  const attempt: QuizAttempt = { id, submittedAt, ...graded };
  return { ...content, batches: content.batches.map((b) => b.id === batchId ? { ...b, draft: null, attempts: [...b.attempts, attempt] } : b) };
}

/** Unknown/corrupt artifacts must never be replaced with an empty history. */
export function parseQuizContent(raw: unknown): QuizContent {
  if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.batches)) throw new Error('저장된 퀴즈 형식을 읽을 수 없습니다');
  const batchIds = new Set<string>();
  const questionIds = new Set<string>();
  const questionKeys = new Set<string>();
  const attemptIds = new Set<string>();
  const batches: QuizBatch[] = raw.batches.map((value) => {
    if (!isObject(value) || !isObject(value.by) || (value.by.engine !== 'claude' && value.by.engine !== 'codex') || !Array.isArray(value.questions) || value.questions.length !== QUIZ_BATCH_SIZE || !Array.isArray(value.attempts)) throw new Error('저장된 퀴즈 묶음이 올바르지 않습니다');
    const id = text(value.id, '퀴즈 묶음 ID', 200);
    if (batchIds.has(id)) throw new Error('저장된 퀴즈 묶음 ID가 중복됩니다');
    batchIds.add(id);
    const questions: QuizQuestion[] = value.questions.map((q) => {
      const fields = questionFields(q);
      if (!isObject(q) || !isObject(q.source)) throw new Error('저장된 근거가 올바르지 않습니다');
      const questionId = text(q.id, '문항 ID', 200);
      if (questionIds.has(questionId) || questionKeys.has(key(fields.question))) throw new Error('저장된 문항이 중복됩니다');
      questionIds.add(questionId);
      questionKeys.add(key(fields.question));
      const s = q.source;
      if (![s.page, s.blockIdx, s.start, s.end].every((n) => typeof n === 'number' && Number.isInteger(n)) || (s.page as number) < 1 || (s.blockIdx as number) < 0 || (s.start as number) < 0 || (s.end as number) <= (s.start as number)) throw new Error('저장된 근거 위치가 올바르지 않습니다');
      return { id: questionId, ...fields, source: { page: s.page as number, blockIdx: s.blockIdx as number, start: s.start as number, end: s.end as number, quote: text(s.quote, '근거 인용문', 2000) } };
    });
    const attempts: QuizAttempt[] = value.attempts.map((a) => {
      if (!isObject(a)) throw new Error('저장된 제출 기록이 올바르지 않습니다');
      const attemptId = text(a.id, '제출 ID', 200);
      if (attemptIds.has(attemptId)) throw new Error('저장된 제출 ID가 중복됩니다');
      attemptIds.add(attemptId);
      const graded = gradeQuiz(questions, a.answers);
      if (a.score !== graded.score) throw new Error('저장된 채점 결과가 올바르지 않습니다');
      return { id: attemptId, submittedAt: text(a.submittedAt, '제출 시각', 100), ...graded };
    });
    let draft: QuizBatch['draft'] = null;
    if (value.draft !== null) {
      if (!isObject(value.draft)) throw new Error('저장된 임시 답안이 올바르지 않습니다');
      draft = { answers: validateQuizAnswers(value.draft.answers, false), updatedAt: text(value.draft.updatedAt, '저장 시각', 100) };
    }
    const by: MadeBy = { engine: value.by.engine };
    if (value.by.model !== undefined) {
      if (typeof value.by.model !== 'string' || value.by.model.length > 200) throw new Error('저장된 모델이 올바르지 않습니다');
      by.model = value.by.model;
    }
    if (value.by.effort !== undefined) {
      if (typeof value.by.effort !== 'string') throw new Error('저장된 모델 설정이 올바르지 않습니다');
      by.effort = value.by.effort;
    }
    return { id, createdAt: text(value.createdAt, '생성 시각', 100), by, questions, draft, attempts };
  });
  return { version: 1, batches };
}

/** Correct answers and explanations are exposed only alongside a server-graded submission. */
export function quizResponse(content: QuizContent | null): QuizResponse {
  return { quiz: content && { version: 1, batches: content.batches.map((b) => ({
    ...b,
    questions: b.questions.map(({ id, question, choices }) => ({ id, question, choices })),
    attempts: b.attempts.map((a) => ({ ...a, total: QUIZ_BATCH_SIZE, results: b.questions.map((q, i) => ({ questionId: q.id, selectedIndex: a.answers[i], correctIndex: q.correctIndex, correct: a.answers[i] === q.correctIndex, explanation: q.explanation, source: q.source })) })),
  })) } };
}
