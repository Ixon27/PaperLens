import { Hono } from 'hono';
import { readQuiz, startQuiz } from '../tasks/quiz';
import { requirePaper } from './papers';

export const quizRoutes = new Hono();

quizRoutes.get('/papers/:id/quiz', (c) => {
  const paper = requirePaper(c.req.param('id'));
  return c.json({ quiz: readQuiz(paper.id) });
});

quizRoutes.post('/papers/:id/quiz', (c) => {
  const paper = requirePaper(c.req.param('id'));
  return c.json({ jobId: startQuiz(paper.id) });
});
