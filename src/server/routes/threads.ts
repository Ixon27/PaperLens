import { Hono } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { nanoid } from 'nanoid';
import { db, getBlocks, getPaper, now, type PaperRow } from '../db';
import { HttpError } from '../http-error';
import { imagePath, imageUrl, removeImage, saveDataUrlPng } from '../images';
import { runLlm } from '../llm';
import { abstractOrPageOne, paperSystem } from '../pdf/context';
import { fill, loadPrompt } from '../prompts';
import { getSettings } from '../settings';

export const threads = new Hono();

type Action = 'ask' | 'explain' | 'figure';

interface ThreadRow {
  id: string;
  paper_id: string;
  title: string;
  created_at: string;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant';
  action: Action | null;
  content: string;
  quote: string | null;
  page: number | null;
  image_file: string | null;
  engine: string | null;
  created_at: string;
}

const TRANSCRIPT_MESSAGES = 12;
const TRANSCRIPT_CHARS = 2000;
const ACTION_LABEL: Record<Exclude<Action, 'ask'>, string> = { explain: '설명 요청', figure: '그림 설명 요청' };

const threadDto = (t: ThreadRow) => ({ id: t.id, title: t.title, createdAt: t.created_at });

const messageDto = (m: MessageRow) => ({
  id: m.id,
  role: m.role,
  action: m.action,
  content: m.content,
  quote: m.quote,
  page: m.page,
  imageUrl: imageUrl(m.image_file),
  engine: m.engine,
  createdAt: m.created_at,
});

const getThread = (tid: string) => db.prepare('SELECT * FROM threads WHERE id=?').get(tid) as ThreadRow | undefined;
const getMessage = (mid: string) => db.prepare('SELECT * FROM messages WHERE id=?').get(mid) as MessageRow | undefined;
const threadMessages = (tid: string) =>
  db.prepare('SELECT * FROM messages WHERE thread_id=? ORDER BY created_at, rowid').all(tid) as unknown as MessageRow[];

function requirePaper(id: string): PaperRow {
  const paper = getPaper(id);
  if (!paper) throw new HttpError(404, '논문을 찾을 수 없습니다');
  return paper;
}

function defaultTitle(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `대화 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Ordered SSE writer: writeSSE is async, so writes are chained to keep event order. */
function sseWriter(stream: SSEStreamingApi) {
  let chain = Promise.resolve();
  return {
    send(event: string, data: unknown) {
      chain = chain.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => {});
    },
    flush: () => chain,
  };
}

// ---------- threads ----------

threads.get('/papers/:id/threads', (c) => {
  const rows = db
    .prepare('SELECT * FROM threads WHERE paper_id=? ORDER BY created_at DESC, rowid DESC')
    .all(c.req.param('id')) as unknown as ThreadRow[];
  return c.json(rows.map(threadDto));
});

threads.post('/papers/:id/threads', async (c) => {
  const paper = requirePaper(c.req.param('id'));
  const body = await c.req.json<{ title?: unknown }>().catch(() => ({ title: undefined }));
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : defaultTitle();
  const id = nanoid(12);
  db.prepare('INSERT INTO threads(id,paper_id,title,created_at) VALUES(?,?,?,?)').run(id, paper.id, title, now());
  return c.json(threadDto(getThread(id)!));
});

threads.get('/threads/:tid/messages', (c) => {
  const t = getThread(c.req.param('tid'));
  if (!t) throw new HttpError(404, '대화를 찾을 수 없습니다');
  return c.json(threadMessages(t.id).map(messageDto));
});

threads.delete('/threads/:tid', (c) => {
  const t = getThread(c.req.param('tid'));
  if (!t) throw new HttpError(404, '대화를 찾을 수 없습니다');
  const images = (db.prepare('SELECT image_file FROM messages WHERE thread_id=? AND image_file IS NOT NULL').all(t.id) as { image_file: string }[]).map(
    (r) => r.image_file,
  );
  db.prepare('DELETE FROM threads WHERE id=?').run(t.id);
  for (const f of images) removeImage(f);
  return c.json({ ok: true });
});

// ---------- ask ----------

function transcript(rows: MessageRow[]): string {
  const recent = rows.slice(-TRANSCRIPT_MESSAGES);
  if (!recent.length) return '';
  const lines = recent.map((m) => {
    let body = m.content;
    if (m.role === 'user') {
      if (m.quote) body = `> ${m.quote.replace(/\s+/g, ' ').trim()}\n${body}`;
      if (m.page) body = `(p.${m.page}) ${body}`;
      if (m.image_file) body += ' (이 메시지에 그림 첨부)';
    }
    return `${m.role === 'user' ? '사용자' : '조교'}: ${body.slice(0, TRANSCRIPT_CHARS)}`;
  });
  return `<대화>\n${lines.join('\n')}\n</대화>`;
}

interface AskBody {
  action?: unknown;
  question?: unknown;
  quote?: unknown;
  page?: unknown;
  imageDataUrl?: unknown;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

threads.post('/threads/:tid/ask', async (c) => {
  const thread = getThread(c.req.param('tid'));
  if (!thread) throw new HttpError(404, '대화를 찾을 수 없습니다');
  const paper = requirePaper(thread.paper_id);
  const body = await c.req.json<AskBody>();
  const action = body.action;
  if (action !== 'ask' && action !== 'explain' && action !== 'figure') throw new HttpError(400, 'action은 ask·explain·figure 중 하나');
  const question = str(body.question);
  const quote = str(body.quote);
  const page = typeof body.page === 'number' && Number.isInteger(body.page) && body.page > 0 ? body.page : null;
  const dataUrl = str(body.imageDataUrl);
  if (action === 'ask' && !question) throw new HttpError(400, '질문이 비었습니다');
  if (action === 'explain' && !quote) throw new HttpError(400, '설명할 문장이 없습니다');
  if (action === 'figure' && !dataUrl) throw new HttpError(400, '그림 이미지가 없습니다');

  const history = threadMessages(thread.id);
  const msgId = nanoid(12);
  const imageFile = dataUrl ? saveDataUrlPng(dataUrl, msgId) : null;
  const content = action === 'ask' ? question! : ACTION_LABEL[action];
  db.prepare(
    'INSERT INTO messages(id,thread_id,role,action,content,quote,page,image_file,engine,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
  ).run(msgId, thread.id, 'user', action, content, quote, page, imageFile, null, now());
  const userMsg = getMessage(msgId)!;

  return streamSSE(c, async (stream) => {
    const out = sseWriter(stream);
    const ac = new AbortController();
    stream.onAbort(() => ac.abort());
    out.send('user', { message: messageDto(userMsg) });
    try {
      const P = loadPrompt('chat');
      const settings = getSettings();
      const system = fill(P.SYSTEM, { context: settings.readerContext }) + '\n\n' + paperSystem(paper);
      const pageStr = page ? String(page) : '?';
      const section =
        action === 'explain'
          ? fill(P.EXPLAIN, { quote: quote!, page: pageStr })
          : action === 'figure'
            ? fill(P.FIGURE, { page: pageStr })
            : fill(P.ASK, { question: question!, quote_block: quote ? `> ${quote.replace(/\n+/g, '\n> ')}` : '' }).trim();
      const head = transcript(history);
      const prompt = head ? `${head}\n\n${section}` : section;
      const engine = settings.engine;
      const answer = await runLlm(
        {
          system,
          prompt,
          imagePath: imageFile ? imagePath(imageFile) : undefined,
          profile: 'quick',
          signal: ac.signal,
          onDelta: (text) => out.send('delta', { text }),
        },
        engine,
      );
      if (ac.signal.aborted) throw new Error('취소됨');
      const aid = nanoid(12);
      db.prepare(
        'INSERT INTO messages(id,thread_id,role,action,content,quote,page,image_file,engine,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      ).run(aid, thread.id, 'assistant', null, answer.trim(), null, null, null, engine, now());
      out.send('done', { message: messageDto(getMessage(aid)!) });
    } catch (e) {
      out.send('error', { message: e instanceof Error ? e.message : String(e) });
    }
    await out.flush();
  });
});

// ---------- selection translation ----------

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

threads.post('/papers/:id/translate-selection', async (c) => {
  const paper = requirePaper(c.req.param('id'));
  const body = await c.req.json<{ text?: unknown; page?: unknown }>();
  const text = str(body.text);
  if (!text) throw new HttpError(400, '번역할 문장이 없습니다');
  const page = typeof body.page === 'number' ? body.page : null;

  const needle = normalize(text).slice(0, 30);
  const surrounding =
    (page !== null && getBlocks(paper.id).find((b) => b.page === page && normalize(b.text).includes(needle))?.text) || '';

  return streamSSE(c, async (stream) => {
    const out = sseWriter(stream);
    const ac = new AbortController();
    stream.onAbort(() => ac.abort());
    try {
      const P = loadPrompt('translate');
      const system = fill(P.SELECTION_SYSTEM, { title: paper.title, abstract: abstractOrPageOne(paper) });
      const prompt = fill(P.SELECTION, { text, surrounding });
      const result = await runLlm({ system, prompt, profile: 'quick', signal: ac.signal, onDelta: (t) => out.send('delta', { text: t }) });
      out.send('done', { text: result.trim() });
    } catch (e) {
      out.send('error', { message: e instanceof Error ? e.message : String(e) });
    }
    await out.flush();
  });
});
