import { useCallback, useEffect, useRef, useState } from 'react';
import { api, postSse } from '../api';
import type { AskInput, ChatItem, MessageDto, ThreadDto } from '../types';

const ACTION_LABEL: Record<Exclude<AskInput['action'], 'ask'>, string> = { explain: '설명 요청', figure: '그림 설명 요청', card: '설명 요청' };

/**
 * Messages of one thread and a streaming `send`. `onThread` receives the thread after each answer
 * (its title may have changed). `send` takes a thread id, or a function creating the thread on first use.
 */
export function useThreadChat(onThread?: (t: ThreadDto) => void) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const onThreadRef = useRef(onThread);
  onThreadRef.current = onThread;

  useEffect(() => () => abortRef.current?.abort(), []);

  const load = useCallback(async (tid: string) => {
    setItems(await api<MessageDto[]>(`/api/threads/${tid}/messages`));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const send = useCallback(async (thread: string | (() => Promise<string>), ask: AskInput) => {
    setBusy(true);
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
        by: null,
        createdAt: stamp,
      },
      { id: liveId, role: 'assistant', action: null, content: '', quote: null, page: null, imageUrl: null, by: null, createdAt: stamp, streaming: true },
    ]);
    let finished = false;
    try {
      const tid = typeof thread === 'string' ? thread : await thread();
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
            const { message, thread: t } = data as { message: MessageDto; thread: ThreadDto };
            setItems((list) => list.map((m) => (m.id === liveId ? message : m)));
            onThreadRef.current?.(t);
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
  }, []);

  return { items, busy, load, clear, send, stop };
}
