import { GripVertical, MessageCircleMore, Minimize2, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { api } from '../api';
import { ChatBubble } from '../components/ChatBubbles';
import { ChatComposer } from '../components/ChatComposer';
import { ChatModelPicker } from '../components/ChatModelPicker';
import { smallBtnCls, smallDangerBtnCls, smallIconBtnCls } from '../components/Dialog';
import { Spinner } from '../components/JobBar';
import { Markdown } from '../components/Markdown';
import { useToast } from '../components/Toast';
import { parseCard } from '../explain-card';
import { useThreadChat } from '../state/useThreadChat';
import { useViewer } from '../state/viewer';
import type { ExplanationDto, ThreadDto } from '../types';
import type { ModelSpec } from '../../shared/models';

export interface CardSize {
  w: number;
  h: number;
}

export const CARD_MIN: CardSize = { w: 300, h: 220 };
const SKIP_CONFIRM_KEY = 'pr.explain.skipDeleteConfirm';
const WRITING = '설명 작성 중…';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A floating AI explanation of one figure, table or section, with follow-up chat. */
export function ExplainCard({
  explanation,
  hidden,
  style,
  size,
  maxWidth,
  onResize,
  onMinimize,
  onDeleted,
  onThread,
  onBusyChange,
  autoStartImage,
  captureImage,
}: {
  explanation: ExplanationDto;
  /** Minimized: kept mounted so a running answer keeps streaming. */
  hidden: boolean;
  /** `left`/`top` inside the PDF scroll content. */
  style: CSSProperties;
  size: CardSize;
  /** The page width minus margins. */
  maxWidth: number;
  onResize(size: CardSize): void;
  onMinimize(): void;
  onDeleted(id: string): void;
  /** `answered`: sent after a saved answer (the marker turns accent). */
  onThread(t: ThreadDto, answered: boolean): void;
  onBusyChange(busy: boolean): void;
  /** Set for a just-created card: write its explanation on mount, with this page image (null: none). */
  autoStartImage: string | null | undefined;
  captureImage(): string | null;
}) {
  const { jumpToPage } = useViewer();
  const toast = useToast();
  const id = explanation.id;
  const chat = useThreadChat((t) => onThread(t, true));
  const { items, busy } = chat;
  const [loaded, setLoaded] = useState(false);
  const [live, setLive] = useState<CardSize | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [dontAsk, setDontAsk] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(false);
  const startedRef = useRef(false);
  const busyRef = useRef(onBusyChange);
  busyRef.current = onBusyChange;

  useEffect(() => busyRef.current(busy), [busy]);

  useEffect(() => {
    let alive = true;
    chat
      .load(id)
      .catch((e: unknown) => alive && toast((e as Error).message, { tone: 'error' }))
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [id, chat.load, toast]);

  // The server drops earlier attempts that never got an answer; mirror that before writing again.
  const writeCard = (image: string | null) => {
    chat.clear();
    void chat.send(id, { action: 'card', imageDataUrl: image ?? undefined });
  };

  const answerIdx = items.findIndex((m) => m.role === 'assistant');
  const answer = answerIdx >= 0 ? items[answerIdx] : undefined;
  const saved = Boolean(answer && !answer.streaming && !answer.error);

  // Before paint, so a new card never flashes its failure state.
  useLayoutEffect(() => {
    if (!loaded || startedRef.current || autoStartImage === undefined) return;
    startedRef.current = true;
    if (!saved) writeCard(autoStartImage);
  }, [loaded]);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const ask = (question: string) => {
    stickRef.current = true;
    void chat.send(id, { action: 'ask', question });
  };

  const changeModel = async (model: ModelSpec | null) => {
    try {
      onThread(await api<ThreadDto>(`/api/threads/${id}`, { method: 'PATCH', json: { model } }), false);
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  };

  const remove = async () => {
    if (dontAsk) localStorage.setItem(SKIP_CONFIRM_KEY, '1');
    chat.stop();
    try {
      await api(`/api/threads/${id}`, { method: 'DELETE' });
      onDeleted(id);
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  };

  const onTrash = () => {
    if (localStorage.getItem(SKIP_CONFIRM_KEY) === '1') void remove();
    else setConfirming(true);
  };

  // The title line streams first; until it is complete the card says it is writing.
  let title = explanation.title;
  if (answer?.streaming || (busy && !saved)) {
    const content = answer?.content ?? '';
    const complete = content.slice(0, content.lastIndexOf('\n') + 1);
    title = parseCard(complete).title ?? (complete.trim() ? explanation.title : WRITING);
  }

  const shown = live ?? { w: Math.min(size.w, maxWidth), h: size.h };
  const onGripDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const start = shown;
    let last = start;
    const move = (ev: PointerEvent) => {
      last = { w: clamp(start.w + ev.clientX - x0, Math.min(CARD_MIN.w, maxWidth), maxWidth), h: Math.max(CARD_MIN.h, start.h + ev.clientY - y0) };
      setLive(last);
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      setLive(null);
      onResize(last);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  };

  const failed = loaded && !busy && !saved;
  const followUps = answerIdx >= 0 ? items.slice(answerIdx + 1) : [];

  return (
    <div
      role="dialog"
      aria-label={`설명: ${title}`}
      hidden={hidden}
      className="pr-tip absolute flex flex-col overflow-hidden rounded-2xl border border-line bg-raised shadow-pop"
      style={{ ...style, width: shown.w, height: shown.h }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        if (confirming) setConfirming(false);
        else onMinimize();
      }}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <Sparkles size={15} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-fg" title={title}>
          {title}
        </span>
        <button className={smallIconBtnCls} aria-label="설명 삭제" title="설명 삭제" onClick={onTrash}>
          <Trash2 size={14} />
        </button>
        <button className={smallIconBtnCls} aria-label="최소화" title="최소화" onClick={onMinimize}>
          <Minimize2 size={14} />
        </button>
      </div>

      {confirming && (
        <div role="alertdialog" aria-label="설명 삭제" className="pr-pop absolute top-12 right-2 z-10 w-[280px] rounded-xl border border-line bg-raised p-3 shadow-pop">
          <p className="text-[13.5px] font-semibold text-fg">설명을 영구 삭제할까요?</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">잠시 숨기려면 옆에 있는 최소화 버튼을 사용하세요.</p>
          <label className="mt-2.5 flex items-center gap-2 text-[12.5px] text-fg">
            <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
            이 메시지를 다시 표시하지 않음
          </label>
          <div className="mt-3 flex justify-end gap-1.5">
            <button className={smallBtnCls} onClick={() => setConfirming(false)}>
              취소
            </button>
            <button className={smallDangerBtnCls} onClick={() => void remove()}>
              삭제
            </button>
          </div>
        </div>
      )}

      <div
        ref={bodyRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {!loaded ? (
          <Spinner text="불러오는 중…" />
        ) : (
          <>
            {answer &&
              (answer.content ? (
                <CardAnswer md={answer.content} busy={busy} onAsk={ask} />
              ) : (
                answer.streaming && <div className="animate-pulse text-[13px] text-fg-dim">{WRITING}</div>
              ))}
            {failed && (
              <div className="flex flex-col items-start gap-2 text-[13px]">
                {answer?.error && <p className="text-danger">{answer.error}</p>}
                <p className="text-fg-muted">설명을 만들지 못했습니다</p>
                <button className={smallBtnCls} onClick={() => writeCard(captureImage())}>
                  다시 시도
                </button>
              </div>
            )}
            {saved && followUps.length > 0 && (
              <ul className="mt-4 flex flex-col gap-4 border-t border-line pt-4">
                {followUps.map((m) => (
                  <ChatBubble key={m.id} m={m} onJump={jumpToPage} />
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-line p-2">
        <ChatComposer
          className="rounded-xl border border-line bg-surface px-2.5 pt-1.5 pb-1.5 transition-colors focus-within:border-line-strong"
          textareaClassName="max-h-28"
          rows={1}
          placeholder="이어서 궁금한 점을 물어보세요."
          busy={busy}
          disabled={!saved}
          onSubmit={ask}
          onStop={chat.stop}
          picker={<ChatModelPicker placement="up" value={explanation.model} disabled={busy} onChange={(m) => void changeModel(m)} />}
        />
      </div>

      <div
        role="separator"
        aria-label="크기 조절"
        className="absolute right-0 bottom-0 grid h-4 w-4 cursor-nwse-resize place-items-center text-fg-dim"
        onPointerDown={onGripDown}
      >
        <GripVertical size={12} className="-rotate-45" />
      </div>
    </div>
  );
}

function CardAnswer({ md, busy, onAsk }: { md: string; busy: boolean; onAsk(question: string): void }) {
  const card = useMemo(() => parseCard(md), [md]);
  return (
    <div className="text-[14px] text-fg">
      <Markdown text={card.body} />
      {card.questions.length > 0 && (
        <>
          <hr className="my-4 border-line" />
          <h4 className="text-[14px] font-semibold text-fg">생각의 확장</h4>
          {card.intro && <Markdown text={card.intro} className="text-fg-muted" />}
          <ol className="mt-1 flex flex-col gap-0.5">
            {card.questions.map((q) => (
              <li key={q}>
                <button
                  className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-accent transition-colors duration-150 hover:bg-hover disabled:opacity-50"
                  disabled={busy}
                  onClick={() => onAsk(q)}
                >
                  <MessageCircleMore size={14} className="mt-0.5 shrink-0" />
                  {q}
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
