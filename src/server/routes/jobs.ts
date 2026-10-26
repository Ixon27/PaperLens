import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { cancelJob, getJobRow, subscribeJob, type JobEvent } from '../jobs';
import { HttpError } from '../http-error';

export const jobs = new Hono();

jobs.get('/jobs/:id', (c) => {
  const row = getJobRow(c.req.param('id'));
  if (!row) throw new HttpError(404, '작업을 찾을 수 없습니다');
  return c.json({ id: row.id, paperId: row.paper_id, kind: row.kind, status: row.status, progress: row.progress, message: row.message, error: row.error });
});

jobs.get('/jobs/:id/events', (c) => {
  const id = c.req.param('id');
  if (!getJobRow(id)) throw new HttpError(404, '작업을 찾을 수 없습니다');
  return streamSSE(c, async (stream) => {
    const { promise: closed, resolve: close } = Promise.withResolvers<void>();
    // Writes are queued so events keep order even though writeSSE is async.
    let chain = Promise.resolve();
    const send = (e: JobEvent) => {
      chain = chain.then(() => stream.writeSSE({ event: e.event, data: JSON.stringify(e.data) })).catch(() => {});
      if (e.event === 'done' || e.event === 'error') chain = chain.then(close);
    };
    const sub = subscribeJob(id, send);
    stream.onAbort(() => {
      sub?.unsubscribe();
      close();
    });
    await closed;
    sub?.unsubscribe();
  });
});

jobs.post('/jobs/:id/cancel', (c) => {
  const id = c.req.param('id');
  if (!getJobRow(id)) throw new HttpError(404, '작업을 찾을 수 없습니다');
  return c.json({ cancelled: cancelJob(id) });
});
