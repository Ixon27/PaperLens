import { nanoid } from 'nanoid';
import { appendQuizBatch, parseQuizContent, validateQuizGeneration, type QuizContent } from '../../shared/quiz';
import { getArtifact, getBlocks, getPaper, now, putArtifact } from '../db';
import { HttpError } from '../http-error';
import { startJob } from '../jobs';
import { parseJsonLoose } from '../json';
import { resolveModel, runLlm } from '../llm';
import { paperSystem } from '../pdf/context';
import { loadPrompt } from '../prompts';

export function readQuiz(paperId: string): QuizContent | null {
  const artifact = getArtifact(paperId, 'quiz');
  if (!artifact) return null;
  try {
    return parseQuizContent(JSON.parse(artifact.content));
  } catch {
    throw new HttpError(409, '저장된 퀴즈 형식을 읽을 수 없습니다. 기존 기록은 그대로 보관되어 있습니다');
  }
}

export function writeQuiz(paperId: string, content: QuizContent): void {
  const by = content.batches.at(-1)?.by ?? null;
  putArtifact(paperId, 'quiz', JSON.stringify(content), { version: 1 }, by);
}

export function startQuiz(paperId: string): string {
  const paper = getPaper(paperId);
  if (!paper) throw new HttpError(404, '논문을 찾을 수 없습니다');
  const blocks = getBlocks(paperId).map((b) => ({ idx: b.idx, page: b.page, text: b.text, isRef: !!b.is_ref }));
  if (!blocks.some((b) => !b.isRef && b.text.replace(/\s/g, '').length >= 12)) throw new HttpError(400, '퀴즈를 만들 PDF 본문이 없습니다. 본문을 불러온 뒤 다시 시도하세요');
  const initial = readQuiz(paperId);
  return startJob(paperId, 'quiz', async (ctx) => {
    const template = loadPrompt('quiz').PROMPT;
    if (!template) throw new Error('prompts/quiz.md 에 PROMPT 섹션이 없습니다');
    const existing = initial?.batches.flatMap((b) => b.questions.map((q) => q.question)) ?? [];
    const prompt = template + '\n\n이미 출제된 질문(다시 출제 금지):\n' + JSON.stringify(existing);
    const by = resolveModel('heavy');
    ctx.progress(0.05, '4지선다 퀴즈 10문항 생성 중…');
    // One explicit request only: invalid output is reported, never silently retried or padded.
    const result = await runLlm({ system: paperSystem(paper, { includeRefs: false }), prompt, profile: 'heavy', model: by, signal: ctx.signal });
    if (ctx.signal.aborted) throw new Error('취소됨');
    ctx.progress(0.9, '문항과 원문 근거 확인 중…');
    const questions = validateQuizGeneration(parseJsonLoose<unknown>(result.text), blocks, existing).map((q) => ({ id: nanoid(12), ...q }));
    // Read after the awaited CLI call. Synchronous read/merge/write cannot interleave with draft or
    // submission routes, so answers saved while generation was running are never overwritten.
    const latest = readQuiz(paperId) ?? { version: 1, batches: [] };
    const next = appendQuizBatch(latest, { id: nanoid(12), createdAt: now(), by: result.by, questions, draft: null, attempts: [] });
    if (ctx.signal.aborted) throw new Error('취소됨');
    writeQuiz(paperId, next);
  });
}
