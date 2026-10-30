import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { quizResponse, saveQuizDraft, submitQuizAttempt } from '../../shared/quiz';
import { now } from '../db';
import { HttpError } from '../http-error';
import { readQuiz, startQuiz, writeQuiz } from '../tasks/quiz';
import { requirePaper } from './papers';

export const quizRoutes = new Hono();

quizRoutes.get('/papers/:id/quiz', (c) => {
  const paper = requirePaper(c.req.param('id'));
  return c.json(quizResponse(readQuiz(paper.id)));
});

quizRoutes.post('/papers/:id/quiz', (c) => {
  const paper = requirePaper(c.req.param('id'));
  return c.json({ jobId: startQuiz(paper.id) });
});

quizRoutes.put('/papers/:id/quiz/batches/:batchId/draft', async (c) => {
  const paper = requirePaper(c.req.param('id'));
  const body: unknown = await c.req.json().catch(() => null);
  const content = readQuiz(paper.id);
  const batchId = c.req.param('batchId');
  if (!content?.batches.some((b) => b.id === batchId)) throw new HttpError(404, '퀴즈 묶음을 찾을 수 없습니다');
  const answers = typeof body === 'object' && body !== null && 'answers' in body ? body.answers : undefined;
  let next;
  try {
    next = saveQuizDraft(content, batchId, answers, now());
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  writeQuiz(paper.id, next);
  return c.json(quizResponse(next));
});

quizRoutes.post('/papers/:id/quiz/batches/:batchId/attempts', async (c) => {
  const paper = requirePaper(c.req.param('id'));
  const body: unknown = await c.req.json().catch(() => null);
  const content = readQuiz(paper.id);
  const batchId = c.req.param('batchId');
  if (!content?.batches.some((b) => b.id === batchId)) throw new HttpError(404, '퀴즈 묶음을 찾을 수 없습니다');
  const answers = typeof body === 'object' && body !== null && 'answers' in body ? body.answers : undefined;
  let next;
  try {
    next = submitQuizAttempt(content, batchId, answers, nanoid(12), now());
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  writeQuiz(paper.id, next);
  return c.json(quizResponse(next));
});
