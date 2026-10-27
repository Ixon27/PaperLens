import { Hono } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { nanoid } from 'nanoid';
import { db, getBlocks, getPaper, madeByOf, now, type BlockRow, type PaperRow } from '../db';
import { HttpError } from '../http-error';
import { imagePath, imageUrl, removeImage, saveDataUrlPng } from '../images';
import { resolveModel, runLlm, validateModelSpec, type ModelSpec } from '../llm';
import { abstractOrPageOne, paperSystem } from '../pdf/context';
import { fill, loadPrompt } from '../prompts';
import { getSettings } from '../settings';
import { anchorId, captionLabel, findAnchor, mentionPattern, parseAnchor, sectionBody, type ExplainAnchor } from '../../shared/explain';

export const threads = new Hono();

type Action = 'ask' | 'explain' | 'figure' | 'card';

interface ThreadRow {
  id: string;
  paper_id: string;
  title: string;
  /** JSON ModelSpec chosen for this conversation; null follows the 빠른 작업 setting. */
  model: string | null;
  /** `explain`: the follow-up chat of a PDF explanation card, anchored at `anchor`. */
  kind: 'chat' | 'explain';
  /** anchorId() of the explained figure/table/section; null on plain chats. */
  anchor: string | null;
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
  made_by: string | null;
  created_at: string;
}

const TRANSCRIPT_MESSAGES = 12;
const TRANSCRIPT_CHARS = 2000;
const ACTION_LABEL: Record<Exclude<Action, 'ask'>, string> = { explain: '설명 요청', figure: '그림 설명 요청', card: '설명 요청' };
const CARD_TITLE = /^\s*#\s+(.+?)\s*#*\s*$/;

const threadDto = (t: ThreadRow) => ({
  id: t.id,
  title: t.title,
  model: t.model ? (JSON.parse(t.model) as ModelSpec) : null,
  kind: t.kind,
  createdAt: t.created_at,
});

const hasAnswer = (tid: string) => db.prepare("SELECT 1 FROM messages WHERE thread_id=? AND role='assistant' LIMIT 1").get(tid) !== undefined;

const explanationDto = (t: ThreadRow) => ({ ...threadDto(t), anchor: JSON.parse(t.anchor!) as ExplainAnchor, answered: hasAnswer(t.id) });

const messageDto = (m: MessageRow) => ({
  id: m.id,
  role: m.role,
  action: m.action,
  content: m.content,
  quote: m.quote,
  page: m.page,
  imageUrl: imageUrl(m.image_file),
  by: madeByOf(m),
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
    .prepare("SELECT * FROM threads WHERE paper_id=? AND kind='chat' ORDER BY created_at DESC, rowid DESC")
    .all(c.req.param('id')) as unknown as ThreadRow[];
  return c.json(rows.map(threadDto));
});

// ---------- explanation cards ----------

type AnchoredBlock = BlockRow & { isRef: boolean };

interface ResolvedAnchor {
  blocks: AnchoredBlock[];
  block: AnchoredBlock;
  /** The section's body paragraphs; empty for figures and tables. */
  body: AnchoredBlock[];
  /** `Figure 2A` / `Table 1`; null for sections. */
  label: string | null;
}

/** The block an anchor points at in the current layout; 404 when it is gone or no longer that kind. */
function resolveAnchor(paperId: string, a: ExplainAnchor): ResolvedAnchor {
  const blocks = getBlocks(paperId).map((b) => ({ ...b, isRef: Boolean(b.is_ref) }));
  const at = findAnchor(blocks, a);
  const block = blocks[at];
  const caption = block && a.type !== 'section' ? captionLabel(block.text) : null;
  if (!block || (a.type !== 'section' && caption?.type !== a.type)) throw new HttpError(404, '설명할 위치를 찾을 수 없습니다');
  const body = a.type === 'section' ? sectionBody(blocks, at) : [];
  if (a.type === 'section' && !body.length) throw new HttpError(400, '이 섹션에서 설명할 본문을 찾지 못했습니다');
  return { blocks, block, body, label: caption?.label ?? null };
}

function cardPrompt(P: Record<string, string>, a: ExplainAnchor, r: ResolvedAnchor, hasImage: boolean): string {
  if (a.type === 'section') {
    const text = [r.block.text, ...r.body.map((b) => b.text)].join('\n\n').slice(0, 8000);
    return fill(P.CARD_SECTION, { page: a.page, heading: r.block.text, text });
  }
  const label = r.label!;
  const mention = mentionPattern(label);
  const mentions = r.blocks
    .filter((b) => b.kind === 'body' && !b.isRef && mention.test(b.text))
    .slice(0, 3)
    .map((b) => `- ${b.text.slice(0, 600)}`)
    .join('\n');
  return fill(P.CARD_FIGURE, {
    page: a.page,
    kind: a.type === 'table' ? '표' : '그림',
    label,
    caption: r.block.text.slice(0, 1500),
    mentions: mentions || '(본문 언급 없음)',
    image_note: hasImage ? '첨부 이미지는 이 쪽 전체다. 위 라벨의 그림·표만 설명하라.' : '쪽 이미지가 없으니 캡션과 본문만으로 설명하라.',
  });
}

threads.get('/papers/:id/explanations', (c) => {
  const rows = db
    .prepare("SELECT * FROM threads WHERE paper_id=? AND kind='explain' ORDER BY created_at, rowid")
    .all(c.req.param('id')) as unknown as ThreadRow[];
  return c.json(rows.map(explanationDto));
});

/** The explanation thread of an anchor, created on first use (the answer comes from `ask` with action `card`). */
threads.post('/papers/:id/explanations', async (c) => {
  const paper = requirePaper(c.req.param('id'));
  const body = await c.req.json<{ anchor?: unknown }>().catch(() => ({}) as { anchor?: unknown });
  const anchor = parseAnchor(body.anchor);
  if (!anchor) throw new HttpError(400, '설명할 위치가 올바르지 않습니다');
  const { block, label } = resolveAnchor(paper.id, anchor);
  const key = anchorId(anchor);
  const existing = db.prepare("SELECT * FROM threads WHERE paper_id=? AND kind='explain' AND anchor=?").get(paper.id, key) as ThreadRow | undefined;
  if (existing) return c.json(explanationDto(existing));
  const id = nanoid(12);
  db.prepare("INSERT INTO threads(id,paper_id,title,model,kind,anchor,created_at) VALUES(?,?,?,NULL,'explain',?,?)").run(
    id,
    paper.id,
    label ?? block.text.slice(0, 40),
    key,
    now(),
  );
  return c.json(explanationDto(getThread(id)!));
});

threads.post('/papers/:id/threads', async (c) => {
  const paper = requirePaper(c.req.param('id'));
  const body = await c.req.json<{ title?: unknown; model?: unknown }>().catch(() => ({}) as { title?: unknown; model?: unknown });
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : defaultTitle();
  const model = body.model == null ? null : JSON.stringify(validateModelSpec(body.model));
  const id = nanoid(12);
  db.prepare('INSERT INTO threads(id,paper_id,title,model,created_at) VALUES(?,?,?,?,?)').run(id, paper.id, title, model, now());
  return c.json(threadDto(getThread(id)!));
});

threads.patch('/threads/:tid', async (c) => {
  const t = getThread(c.req.param('tid'));
  if (!t) throw new HttpError(404, '대화를 찾을 수 없습니다');
  const body = await c.req.json<{ model?: unknown }>().catch(() => ({}) as { model?: unknown });
  const model = body.model == null ? null : JSON.stringify(validateModelSpec(body.model));
  db.prepare('UPDATE threads SET model=? WHERE id=?').run(model, t.id);
  return c.json(threadDto(getThread(t.id)!));
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
  if (action !== 'ask' && action !== 'explain' && action !== 'figure' && action !== 'card') throw new HttpError(400, 'action은 ask·explain·figure·card 중 하나');
  const question = str(body.question);
  const quote = str(body.quote);
  const page = typeof body.page === 'number' && Number.isInteger(body.page) && body.page > 0 ? body.page : null;
  const dataUrl = str(body.imageDataUrl);
  if (action === 'ask' && !question) throw new HttpError(400, '질문이 비었습니다');
  if (action === 'explain' && !quote) throw new HttpError(400, '설명할 문장이 없습니다');
  if (action === 'figure' && !dataUrl) throw new HttpError(400, '그림 이미지가 없습니다');
  // Before anything is stored or streamed: a model that is no longer valid is a plain 400.
  const by = thread.model ? validateModelSpec(JSON.parse(thread.model)) : resolveModel('quick');

  let history = threadMessages(thread.id);
  let card: { anchor: ExplainAnchor; resolved: ResolvedAnchor } | null = null;
  if (action === 'card') {
    const anchor = thread.kind === 'explain' && thread.anchor ? parseAnchor(JSON.parse(thread.anchor)) : null;
    if (!anchor) throw new HttpError(400, '설명 카드가 아닌 대화입니다');
    if (history.some((m) => m.role === 'assistant')) throw new HttpError(400, '이미 설명이 있습니다');
    card = { anchor, resolved: resolveAnchor(paper.id, anchor) };
    // Earlier attempts that never got an answer: the card starts over.
    db.prepare('DELETE FROM messages WHERE thread_id=?').run(thread.id);
    for (const m of history) removeImage(m.image_file);
    history = [];
  }
  const msgId = nanoid(12);
  const imageFile = dataUrl ? saveDataUrlPng(dataUrl, msgId) : null;
  const content = action === 'ask' ? question! : ACTION_LABEL[action];
  db.prepare(
    'INSERT INTO messages(id,thread_id,role,action,content,quote,page,image_file,engine,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
  ).run(msgId, thread.id, 'user', action, content, card ? card.resolved.block.text.slice(0, 300) : quote, card ? card.anchor.page : page, imageFile, null, now());
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
      const section = card
        ? cardPrompt(P, card.anchor, card.resolved, imageFile !== null)
        : action === 'explain'
          ? fill(P.EXPLAIN, { quote: quote!, page: pageStr })
          : action === 'figure'
            ? fill(P.FIGURE, { page: pageStr })
            : fill(P.ASK, { question: question!, quote_block: quote ? `> ${quote.replace(/\n+/g, '\n> ')}` : '' }).trim();
      const head = transcript(history);
      const prompt = head ? `${head}\n\n${section}` : section;
      const result = await runLlm({
        system,
        prompt,
        imagePath: imageFile ? imagePath(imageFile) : undefined,
        profile: 'quick',
        model: by,
        signal: ac.signal,
        onDelta: (text) => out.send('delta', { text }),
      });
      if (ac.signal.aborted) throw new Error('취소됨');
      const aid = nanoid(12);
      db.prepare(
        'INSERT INTO messages(id,thread_id,role,action,content,quote,page,image_file,engine,made_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      ).run(aid, thread.id, 'assistant', null, result.text.trim(), null, null, null, by.engine, JSON.stringify(by), now());
      if (card) {
        const title = result.text
          .split('\n')
          .map((line) => CARD_TITLE.exec(line)?.[1])
          .find(Boolean);
        if (title) db.prepare('UPDATE threads SET title=? WHERE id=?').run(title.slice(0, 40), thread.id);
      }
      out.send('done', { message: messageDto(getMessage(aid)!), thread: threadDto(getThread(thread.id)!) });
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
      const system = fill(P.SYSTEM, { title: paper.title, abstract: abstractOrPageOne(paper) });
      const prompt = fill(P.SELECTION, { text, surrounding });
      const by = resolveModel('quick');
      const result = await runLlm({ system, prompt, profile: 'quick', model: by, signal: ac.signal, onDelta: (t) => out.send('delta', { text: t }) });
      out.send('done', { text: result.text.trim(), by });
    } catch (e) {
      out.send('error', { message: e instanceof Error ? e.message : String(e) });
    }
    await out.flush();
  });
});
