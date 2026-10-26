import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, postSse } from '../api';
import { Markdown, PageChip } from '../components/Markdown';
import { useToast } from '../components/Toast';
import { usePaper } from '../state/paper';
import { useViewer } from '../state/viewer';
import type { AskInput } from '../types';

interface ThreadDto {
  id: string;
  title: string;
  createdAt: string;
}

interface MessageDto {
  id: string;
  role: 'user' | 'assistant';
  action: AskInput['action'] | null;
  content: string;
  quote: string | null;
  page: number | null;
  imageUrl: string | null;
  engine: string | null;
  createdAt: string;
}

/** A message in the list; the live assistant bubble carries `streaming`/`error`. */
type ChatItem = MessageDto & { streaming?: boolean; error?: string };

const ACTION_LABEL: Record<Exclude<AskInput['action'], 'ask'>, string> = { explain: '설명 요청', figure: '그림 설명 요청' };

export function ChatPanel() {
  const { paper } = usePaper();
  const { pendingAsk, takePendingAsk, jumpToPage } = useViewer();
  const toast = useToast();
  const [threads, setThreads] = useState<ThreadDto[] | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const handledRef = useRef(new Set<number>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const loadMessages = useCallback(async (tid: string) => {
    setItems(await api<MessageDto[]>(`/api/threads/${tid}/messages`));
    stickRef.current = true;
  }, []);

  useEffect(() => {
    let alive = true;
    api<ThreadDto[]>(`/api/papers/${paper.id}/threads`)
      .then(async (list) => {
        if (!alive) return;
        setThreads(list);
        if (list[0]) {
          setCurrentId(list[0].id);
          await loadMessages(list[0].id);
        }
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setThreads([]);
        toast((e as Error).message, { tone: 'error' });
      });
    return () => {
      alive = false;
      abortRef.current?.abort();
    };
  }, [paper.id, loadMessages, toast]);

  // Keep the newest message in view while it streams, unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const createThread = async (): Promise<ThreadDto> => {
    const t = await api<ThreadDto>(`/api/papers/${paper.id}/threads`, { method: 'POST', json: {} });
    setThreads((list) => [t, ...(list ?? [])]);
    setCurrentId(t.id);
    return t;
  };

  const send = async (ask: AskInput) => {
    setBusy(true);
    stickRef.current = true;
    const ac = new AbortController();
    abortRef.current = ac;
    const stamp = new Date().toISOString();
    const tempUserId = `tmp-user-${stamp}`;
    const liveId = `tmp-live-${stamp}`;
    const patchLive = (fn: (m: ChatItem) => ChatItem) => setItems((list) => list.map((m) => (m.id === liveId ? fn(m) : m)));
    setItems((list) => [
      ...list,
      {
        id: tempUserId,
        role: 'user',
        action: ask.action,
        content: ask.action === 'ask' ? (ask.question ?? '') : ACTION_LABEL[ask.action],
        quote: ask.quote ?? null,
        page: ask.page ?? null,
        imageUrl: ask.imageDataUrl ?? null,
        engine: null,
        createdAt: stamp,
      },
      { id: liveId, role: 'assistant', action: null, content: '', quote: null, page: null, imageUrl: null, engine: null, createdAt: stamp, streaming: true },
    ]);
    let finished = false;
    try {
      const tid = currentId ?? (await createThread()).id;
      await postSse(`/api/threads/${tid}/ask`, ask, {
        signal: ac.signal,
        onEvent: (event, data) => {
          if (event === 'user') {
            const { message } = data as { message: MessageDto };
            // keep the local data URL thumbnail: it is already decoded
            setItems((list) => list.map((m) => (m.id === tempUserId ? { ...message, imageUrl: m.imageUrl ?? message.imageUrl } : m)));
          } else if (event === 'delta') {
            const { text } = data as { text: string };
            patchLive((m) => ({ ...m, content: m.content + text }));
          } else if (event === 'done') {
            finished = true;
            const { message } = data as { message: MessageDto };
            setItems((list) => list.map((m) => (m.id === liveId ? message : m)));
          } else if (event === 'error') {
            finished = true;
            const { message } = data as { message: string };
            patchLive((m) => ({ ...m, streaming: false, error: message }));
          }
        },
      });
      if (!finished) patchLive((m) => ({ ...m, streaming: false, error: '응답이 끊겼습니다' }));
    } catch (e) {
      patchLive((m) => ({ ...m, streaming: false, error: ac.signal.aborted ? '중지됨' : (e as Error).message }));
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setBusy(false);
    }
  };

  // Requests from the PDF (설명 / 질문 / 그림 설명) arrive through the viewer context.
  useEffect(() => {
    if (!pendingAsk || busy || threads === null) return;
    const { nonce, ...ask } = pendingAsk;
    takePendingAsk(nonce);
    if (handledRef.current.has(nonce)) return;
    handledRef.current.add(nonce);
    void send(ask);
    // `send` is recreated every render and reads current state; only these inputs should retrigger.
  }, [pendingAsk, busy, threads]);

  const submit = () => {
    const q = input.trim();
    if (!q || busy) return;
    setInput('');
    void send({ action: 'ask', question: q });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    submit();
  };

  const selectThread = (tid: string) => {
    setCurrentId(tid);
    void loadMessages(tid).catch((e: unknown) => toast((e as Error).message, { tone: 'error' }));
  };

  const deleteThread = async () => {
    if (!currentId || !confirm('이 대화를 지울까요?')) return;
    try {
      await api(`/api/threads/${currentId}`, { method: 'DELETE' });
      const rest = (threads ?? []).filter((t) => t.id !== currentId);
      setThreads(rest);
      setItems([]);
      setCurrentId(rest[0]?.id ?? null);
      if (rest[0]) await loadMessages(rest[0].id);
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-stone-200 bg-white px-3 py-2">
        <select
          className="min-w-0 flex-1 rounded border border-stone-300 bg-white px-2 py-1 text-[13px] disabled:opacity-60"
          value={currentId ?? ''}
          disabled={busy || !threads?.length}
          onChange={(e) => selectThread(e.target.value)}
        >
          {!threads?.length && <option value="">대화 없음</option>}
          {threads?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
        <button
          className="rounded border border-stone-300 px-2 py-1 text-[12.5px] hover:bg-stone-100 disabled:opacity-50"
          disabled={busy}
          onClick={() =>
            void createThread()
              .then(() => setItems([]))
              .catch((e: unknown) => toast((e as Error).message, { tone: 'error' }))
          }
        >
          새 대화
        </button>
        {currentId && (
          <button className="rounded px-1.5 py-1 text-[12px] text-stone-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50" disabled={busy} onClick={() => void deleteThread()}>
            삭제
          </button>
        )}
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {!items.length ? (
          <div className="p-3 text-[13px] text-stone-500">논문에 대해 물어보세요. PDF에서 글을 선택해 `설명`·`질문`을 누르거나, Alt+드래그한 영역에서 `설명`을 눌러도 됩니다.</div>
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((m) => (m.role === 'user' ? <UserBubble key={m.id} m={m} onJump={jumpToPage} /> : <AssistantBubble key={m.id} m={m} />))}
          </ul>
        )}
      </div>

      <div className="flex items-end gap-2 border-t border-stone-200 bg-white p-2">
        <textarea
          className="max-h-40 min-h-[38px] flex-1 resize-y rounded border border-stone-300 px-2 py-1.5 text-[13px] outline-none focus:border-stone-500"
          rows={2}
          placeholder="질문 입력 (Enter 보내기, Shift+Enter 줄바꿈)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {busy ? (
          <button className="rounded bg-red-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-red-700" onClick={() => abortRef.current?.abort()}>
            중지
          </button>
        ) : (
          <button className="rounded bg-stone-800 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-stone-900 disabled:opacity-40" disabled={!input.trim()} onClick={submit}>
            보내기
          </button>
        )}
      </div>
    </div>
  );
}

function UserBubble({ m, onJump }: { m: ChatItem; onJump(n: number): void }) {
  return (
    <li className="ml-8 self-end rounded-lg bg-blue-50 px-3 py-2 text-[13px] text-stone-800 ring-1 ring-blue-100">
      {m.quote && <blockquote className="mb-1.5 line-clamp-6 border-l-2 border-blue-300 pl-2 text-[12.5px] text-stone-600">{m.quote}</blockquote>}
      {m.imageUrl && <img src={m.imageUrl} alt="첨부 그림" className="mb-1.5 max-h-40 max-w-full rounded border border-stone-200 bg-white" />}
      <div className="whitespace-pre-wrap">
        {m.content}
        {m.page !== null && <PageChip page={m.page} onJump={onJump} />}
      </div>
    </li>
  );
}

function AssistantBubble({ m }: { m: ChatItem }) {
  return (
    <li className="mr-4 rounded-lg border border-stone-200 bg-white px-3 py-2 text-[13.5px] text-stone-800">
      {m.content ? <Markdown text={m.content} /> : m.streaming && <div className="animate-pulse text-stone-400">생성 중…</div>}
      {m.error && <div className="mt-1 text-[12.5px] text-red-600">{m.error}</div>}
      {m.engine && <div className="mt-1 text-right text-[11px] text-stone-400">{m.engine}</div>}
    </li>
  );
}
