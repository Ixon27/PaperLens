import { ChevronDown, Copy, MessageCircle, Plus, RotateCw, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { ChatBubble } from '../components/ChatBubbles';
import { ChatComposer } from '../components/ChatComposer';
import { ChatModelPicker } from '../components/ChatModelPicker';
import { smallBtnCls, smallGhostBtnCls, smallIconBtnCls } from '../components/Dialog';
import { isCancelled, JobBar, Spinner } from '../components/JobBar';
import { Markdown, PageChip } from '../components/Markdown';
import { ModelBadge } from '../components/ModelBadge';
import { splitSections } from '../components/SectionedMarkdown';
import { useCopy, useToast } from '../components/Toast';
import { usePaper } from '../state/paper';
import { useArtifact } from '../state/useArtifact';
import { useJob } from '../state/useJob';
import { useThreadChat } from '../state/useThreadChat';
import { useViewer } from '../state/viewer';
import { ALT_KEY } from '../labels';
import type { AskInput, ChatItem, TermDto, ThreadDto } from '../types';
import type { ModelSpec } from '../../shared/models';

type SectionId = 'keywords' | 'tldr' | 'summary' | 'discussion';
type OpenState = Record<SectionId, boolean>;

const OPEN_KEY = 'pr.overview.open';
const ALL_OPEN: OpenState = { keywords: true, tldr: true, summary: true, discussion: true };

function readOpen(): OpenState {
  const out = { ...ALL_OPEN };
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as Record<string, unknown>;
    for (const id of Object.keys(ALL_OPEN) as SectionId[]) {
      const v = saved[id];
      if (typeof v === 'boolean') out[id] = v;
    }
  } catch {
    // a corrupt value opens everything
  }
  return out;
}

/** Papers whose summary / core terms were started automatically in this app session (never twice). */
const autoSummaryStarted = new Set<string>();
const autoKeywordsStarted = new Set<string>();

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 키워드 사전, 3줄 요약, 요약 and 토론 in one scroll, with the question box pinned below. */
export function OverviewPanel() {
  const [open, setOpenState] = useState(readOpen);
  const setOpen = useCallback((id: SectionId, on: boolean) => {
    setOpenState((o) => {
      const next = { ...o, [id]: on };
      localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Follow the streaming answer; set by sending, cleared when the reader scrolls up. */
  const stickRef = useRef(false);
  const onActivity = useCallback(() => {
    setOpen('discussion', true);
    stickRef.current = true;
  }, [setOpen]);
  const talk = useDiscussion(onActivity);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [talk.chat.items]);

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-1"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <KeywordsSection open={open.keywords} onOpenChange={(on) => setOpen('keywords', on)} />
        <SummarySections open={open} setOpen={setOpen} />
        <DiscussionSection talk={talk} open={open.discussion} onOpenChange={(on) => setOpen('discussion', on)} />
      </div>
      <ChatComposer
        className="m-3 rounded-[18px] border border-line bg-raised px-3 pt-2 pb-2 transition-colors focus-within:border-line-strong"
        textareaClassName="max-h-40"
        rows={2}
        placeholder="무엇이든 질문하세요 (Shift+Enter 줄바꿈)"
        busy={talk.chat.busy}
        onSubmit={(question) => talk.send({ action: 'ask', question })}
        onStop={talk.chat.stop}
        picker={
          <ChatModelPicker
            placement="up"
            value={talk.currentThread ? talk.currentThread.model : talk.pendingModel}
            disabled={talk.chat.busy}
            onChange={(m) => void talk.changeModel(m)}
          />
        }
      />
    </div>
  );
}

function OverviewSection({
  id,
  title,
  open,
  onOpenChange,
  actions,
  sectionRef,
  children,
}: {
  id: SectionId;
  title: string;
  open: boolean;
  onOpenChange(on: boolean): void;
  actions?: ReactNode;
  sectionRef?: RefObject<HTMLElement>;
  children: ReactNode;
}) {
  return (
    <section ref={sectionRef} aria-labelledby={`overview-${id}`} className="scroll-mt-1">
      <div className="flex h-10 items-center gap-1.5 px-3">
        <button
          id={`overview-${id}`}
          className="flex min-w-0 items-center gap-1.5 rounded-md py-1 pr-1 text-left"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
        >
          <ChevronDown size={14} className={`shrink-0 text-fg-muted transition-transform duration-200 ${open ? '' : '-rotate-90'}`} />
          <span className="truncate text-[14px] font-semibold text-fg">{title}</span>
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">{actions}</div>
      </div>
      <div className="pr-accordion" data-open={open || undefined}>
        <div
          ref={(el) => {
            if (el) el.inert = !open;
          }}
        >
          <div className="px-4 pb-4">{children}</div>
        </div>
      </div>
    </section>
  );
}

/** Clips long content to `maxPx` with a fade and a 더 보기 toggle. */
function Clamp({ maxPx, children }: { maxPx: number; children: ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = () => setOver(el.scrollHeight > maxPx + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxPx]);

  const clipped = over && !expanded;
  return (
    <div>
      <div className="relative overflow-hidden" style={clipped ? { maxHeight: maxPx } : undefined}>
        <div ref={innerRef}>{children}</div>
        {clipped && (
          <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-12" style={{ background: 'linear-gradient(to bottom, transparent, var(--pr-surface))' }} />
        )}
      </div>
      {over && (
        <button className={`${smallGhostBtnCls} mt-1 -ml-2`} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? (
            <>
              <X size={12} />
              간략히 보기
            </>
          ) : (
            '더 보기'
          )}
        </button>
      )}
    </div>
  );
}

// ---------- 키워드 사전 ----------

const HOVER_MS = 150;

function KeywordsSection({ open, onOpenChange }: { open: boolean; onOpenChange(on: boolean): void }) {
  const { paper } = usePaper();
  const { termsVersion, keywordsFocus } = useViewer();
  const toast = useToast();
  const copy = useCopy();
  const [terms, setTerms] = useState<TermDto[] | null>(null);
  const [hover, setHover] = useState<{ term: TermDto; rect: DOMRect } | null>(null);
  const timers = useRef<{ open?: ReturnType<typeof setTimeout>; close?: ReturnType<typeof setTimeout> }>({});
  const sectionRef = useRef<HTMLElement>(null);
  const focusSeen = useRef(0);

  const reload = useCallback(async () => {
    try {
      setTerms(await api<TermDto[]>(`/api/papers/${paper.id}/terms`));
    } catch (e) {
      setTerms((t) => t ?? []);
      toast((e as Error).message, { tone: 'error' });
    }
  }, [paper.id, toast]);
  useEffect(() => {
    void reload();
  }, [reload, termsVersion]);

  const kw = useJob('keywords', { onFinish: () => void reload() });
  const start = useCallback(async () => {
    try {
      const { jobId } = await api<{ jobId: string }>(`/api/papers/${paper.id}/keywords`, { method: 'POST' });
      kw.attach(jobId);
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  }, [paper.id, kw.attach, toast]);

  // The first time a paper without AI-picked terms shows here, pick them.
  useEffect(() => {
    if (terms === null || terms.some((t) => t.source === 'auto') || !kw.loaded || kw.running || kw.job?.status === 'error') return;
    if (autoKeywordsStarted.has(paper.id)) return;
    autoKeywordsStarted.add(paper.id);
    void start();
  }, [terms, kw.loaded, kw.running, kw.job?.status, paper.id, start]);

  // 키워드 사전에서 보기 (TermCard).
  useEffect(() => {
    if (keywordsFocus === focusSeen.current) return;
    focusSeen.current = keywordsFocus;
    onOpenChange(true);
    sectionRef.current?.scrollIntoView({ block: 'start' });
  }, [keywordsFocus, onOpenChange]);

  const showTerm = (term: TermDto, el: HTMLElement, delay: number) => {
    clearTimeout(timers.current.close);
    clearTimeout(timers.current.open);
    timers.current.open = setTimeout(() => setHover({ term, rect: el.getBoundingClientRect() }), delay);
  };
  const hideSoon = () => {
    clearTimeout(timers.current.open);
    clearTimeout(timers.current.close);
    timers.current.close = setTimeout(() => setHover(null), HOVER_MS);
  };
  const keep = () => clearTimeout(timers.current.close);
  useEffect(
    () => () => {
      clearTimeout(timers.current.open);
      clearTimeout(timers.current.close);
    },
    [],
  );
  useEffect(() => {
    if (!open) setHover(null);
  }, [open]);
  // The popover is fixed on screen: scrolling or Esc dismisses it.
  useEffect(() => {
    if (!hover) return;
    const close = () => setHover(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [hover]);

  const remove = async (t: TermDto) => {
    try {
      await api(`/api/terms/${t.id}`, { method: 'DELETE' });
      setHover(null);
      await reload();
      toast('삭제했습니다');
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  };

  const copyAll = () => copy((terms ?? []).map((t) => `${t.term}${t.ko && t.ko !== t.term ? ` (${t.ko})` : ''}: ${t.definition}`).join('\n'));
  const regenerate = () => {
    if (confirm('핵심 용어를 다시 만들까요? 직접 찾은 용어는 그대로 둡니다.')) void start();
  };
  const failed = !kw.running && kw.job?.status === 'error' && !isCancelled(kw.job);

  return (
    <OverviewSection
      id="keywords"
      title="키워드 사전"
      open={open}
      onOpenChange={onOpenChange}
      sectionRef={sectionRef}
      actions={
        <>
          <button className={smallIconBtnCls} aria-label="키워드 사전 복사" title="복사" disabled={!terms?.length} onClick={copyAll}>
            <Copy size={14} />
          </button>
          <button className={smallIconBtnCls} aria-label="핵심 용어 다시 만들기" title="핵심 용어 다시 만들기" disabled={kw.running} onClick={regenerate}>
            <RotateCw size={14} />
          </button>
        </>
      }
    >
      {kw.running && (
        <div className="mb-2">
          <JobBar job={kw.job} onCancel={() => void kw.cancel()} />
        </div>
      )}
      {failed && (
        <div className="mb-2 flex items-center gap-2 text-[13px] text-danger">
          <span className="min-w-0 flex-1">{kw.job?.error ?? '핵심 용어를 만들지 못했습니다'}</span>
          <button className={smallBtnCls} onClick={() => void start()}>
            다시 시도
          </button>
        </div>
      )}
      {terms !== null && !terms.length && !kw.running && (
        <p className="text-[12.5px] leading-relaxed text-fg-muted">PDF나 번역에서 용어를 드래그한 뒤 '용어'를 누르면 여기에 모입니다.</p>
      )}
      {!!terms?.length && (
        <Clamp maxPx={88}>
          <ul className="flex flex-wrap gap-1.5">
            {terms.map((t) => (
              <li key={t.id} className="min-w-0 max-w-full">
                <button
                  className="h-8 max-w-full truncate rounded-full bg-sunken px-3 text-[13px] text-fg transition-colors duration-150 hover:bg-hover"
                  aria-expanded={hover?.term.id === t.id}
                  onPointerEnter={(e) => showTerm(t, e.currentTarget, HOVER_MS)}
                  onPointerLeave={hideSoon}
                  onFocus={(e) => showTerm(t, e.currentTarget, 0)}
                  onBlur={hideSoon}
                  onClick={(e) => showTerm(t, e.currentTarget, 0)}
                >
                  {t.term}
                </button>
              </li>
            ))}
          </ul>
        </Clamp>
      )}
      {hover && <KeywordPopover term={hover.term} rect={hover.rect} onEnter={keep} onLeave={hideSoon} onDelete={() => void remove(hover.term)} />}
    </OverviewSection>
  );
}

function KeywordPopover({ term, rect, onEnter, onLeave, onDelete }: { term: TermDto; rect: DOMRect; onEnter(): void; onLeave(): void; onDelete(): void }) {
  const { jumpToPage } = useViewer();
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(rect.bottom + 6);

  // Below the chip, or above it when it would run off the window.
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0;
    setTop(rect.bottom + 6 + h > innerHeight - 8 ? Math.max(8, rect.top - 6 - h) : rect.bottom + 6);
  }, [rect, term]);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={term.term}
      className="pr-tip fixed z-[80] w-[320px] rounded-xl border border-line bg-raised p-3 shadow-pop"
      style={{ top, left: clamp(rect.left, 8, innerWidth - 328) }}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
    >
      <div>
        <span className="text-[14px] font-semibold text-fg">{term.term}</span>
        {term.ko !== term.term && <span className="ml-1.5 text-[13px] text-accent">{term.ko}</span>}
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-fg">{term.definition}</p>
      {term.inPaper && (
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-muted">
          <span className="font-medium">이 논문에서</span> {term.inPaper}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        {term.page !== null && <PageChip page={term.page} onJump={jumpToPage} />}
        <span className="min-w-0 flex-1 truncate">
          <ModelBadge by={term.by} />
        </span>
        <button className={smallIconBtnCls} aria-label={`${term.term} 삭제`} title="삭제" onClick={onDelete}>
          <Trash2 size={13} />
        </button>
      </div>
    </div>,
    document.body,
  );
}

// ---------- 3줄 요약 · 요약 ----------

/** The summary's `#### 3줄 요약` body, and every other section re-joined. */
function splitSummary(md: string): { tldr: string; rest: string } {
  const sections = splitSections(md);
  const tldr = sections.find((s) => s.title?.startsWith('3줄 요약'));
  const rest = sections
    .filter((s) => s !== tldr)
    .map((s) => (s.title ? `#### ${s.title}\n\n${s.body}` : s.body))
    .join('\n\n')
    .trim();
  return { tldr: tldr?.body ?? '', rest };
}

function SummarySections({ open, setOpen }: { open: OpenState; setOpen(id: SectionId, on: boolean): void }) {
  const { paper } = usePaper();
  const toast = useToast();
  const copy = useCopy();
  const { artifact, load } = useArtifact(paper.id, 'summary');
  const h = useJob('summary', { onFinish: () => void load() });

  const start = useCallback(async () => {
    try {
      const { jobId } = await api<{ jobId: string }>(`/api/papers/${paper.id}/summary`, { method: 'POST' });
      h.attach(jobId);
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  }, [paper.id, h.attach, toast]);

  // The first time this panel shows a paper without a summary, make one.
  useEffect(() => {
    if (artifact !== null || !h.loaded || h.running || h.job?.status === 'error' || autoSummaryStarted.has(paper.id)) return;
    autoSummaryStarted.add(paper.id);
    void start();
  }, [artifact, h.loaded, h.running, h.job?.status, paper.id, start]);

  const source = h.running ? h.text : (artifact?.content ?? '');
  const { tldr, rest } = useMemo(() => splitSummary(source), [source]);

  const regenerate = () => {
    if (confirm('요약을 다시 만들까요?')) void start();
  };
  const actions = (label: string, body: string) => (
    <>
      <button className={smallIconBtnCls} aria-label={`${label} 복사`} title="복사" disabled={!body} onClick={() => copy(body)}>
        <Copy size={14} />
      </button>
      <button className={smallIconBtnCls} aria-label="요약 다시 만들기" title="다시 만들기" disabled={h.running} onClick={regenerate}>
        <RotateCw size={14} />
      </button>
    </>
  );

  let status: ReactNode = null;
  if (!h.running && !artifact) {
    if (h.job?.status === 'error' && !isCancelled(h.job)) {
      status = (
        <div className="flex items-center gap-2 text-[13px] text-danger">
          <span className="min-w-0 flex-1">{h.job.error ?? '요약을 만들지 못했습니다'}</span>
          <button className={smallBtnCls} onClick={() => void start()}>
            다시 시도
          </button>
        </div>
      );
    } else if (isCancelled(h.job)) {
      status = (
        <div className="flex items-center gap-2 text-[13px] text-fg-muted">
          <span className="min-w-0 flex-1">요약을 멈췄습니다</span>
          <button className={smallBtnCls} onClick={() => void start()}>
            요약 만들기
          </button>
        </div>
      );
    } else if (artifact === null) {
      status = <Spinner text="요약 준비 중…" />;
    }
  }
  const badge = artifact && !h.running && (
    <div className="mt-2 text-right">
      <ModelBadge by={artifact.by} />
    </div>
  );

  return (
    <>
      <OverviewSection id="tldr" title="3줄 요약" open={open.tldr} onOpenChange={(on) => setOpen('tldr', on)} actions={actions('3줄 요약', tldr)}>
        {tldr ? <Markdown text={tldr} /> : h.running ? <Spinner text="요약 작성 중…" /> : status}
        {tldr && badge}
      </OverviewSection>
      <OverviewSection id="summary" title="요약" open={open.summary} onOpenChange={(on) => setOpen('summary', on)} actions={actions('요약', rest)}>
        {h.running && (
          <div className="mb-2">
            <JobBar job={h.job} onCancel={() => void h.cancel()} />
          </div>
        )}
        {rest && (
          <Clamp maxPx={320}>
            <Markdown text={rest} />
          </Clamp>
        )}
        {rest && badge}
      </OverviewSection>
    </>
  );
}

// ---------- 토론 ----------

type Discussion = ReturnType<typeof useDiscussion>;

/** The paper's discussion threads (not explanation cards) and the PDF's 설명·질문 requests. `onActivity` runs on every send. */
function useDiscussion(onActivity: () => void) {
  const { paper } = usePaper();
  const { pendingAsk, takePendingAsk } = useViewer();
  const toast = useToast();
  const [threads, setThreads] = useState<ThreadDto[] | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  /** The model for a discussion that does not exist yet. */
  const [pendingModel, setPendingModel] = useState<ModelSpec | null>(null);
  const chat = useThreadChat((t) => setThreads((list) => list && list.map((x) => (x.id === t.id ? t : x))));
  const { load, clear } = chat;
  const handledRef = useRef(new Set<number>());

  useEffect(() => {
    let alive = true;
    api<ThreadDto[]>(`/api/papers/${paper.id}/threads`)
      .then(async (list) => {
        if (!alive) return;
        setThreads(list);
        if (list[0]) {
          setCurrentId(list[0].id);
          await load(list[0].id);
        }
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setThreads([]);
        toast((e as Error).message, { tone: 'error' });
      });
    return () => {
      alive = false;
    };
  }, [paper.id, load, toast]);

  const createThread = async (): Promise<ThreadDto> => {
    const t = await api<ThreadDto>(`/api/papers/${paper.id}/threads`, { method: 'POST', json: { model: pendingModel } });
    setThreads((list) => [t, ...(list ?? [])]);
    setCurrentId(t.id);
    return t;
  };

  const currentThread = threads?.find((t) => t.id === currentId) ?? null;

  const changeModel = async (model: ModelSpec | null) => {
    if (!currentThread) {
      setPendingModel(model);
      return;
    }
    try {
      const t = await api<ThreadDto>(`/api/threads/${currentThread.id}`, { method: 'PATCH', json: { model } });
      setThreads((list) => list && list.map((x) => (x.id === t.id ? t : x)));
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  };

  const send = (ask: AskInput) => {
    onActivity();
    void chat.send(currentId ?? (async () => (await createThread()).id), ask);
  };

  // Requests from the PDF (설명 / 질문 / 그림 설명) arrive through the viewer context.
  useEffect(() => {
    if (!pendingAsk || chat.busy || threads === null) return;
    const { nonce, ...ask } = pendingAsk;
    takePendingAsk(nonce);
    if (handledRef.current.has(nonce)) return;
    handledRef.current.add(nonce);
    send(ask);
    // `send` is recreated every render and reads current state; only these inputs should retrigger.
  }, [pendingAsk, chat.busy, threads]);

  const newThread = async () => {
    try {
      await createThread();
      clear();
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  };

  const selectThread = (tid: string) => {
    setCurrentId(tid);
    void load(tid).catch((e: unknown) => toast((e as Error).message, { tone: 'error' }));
  };

  const deleteThread = async () => {
    if (!currentId || !confirm('이 토론을 지울까요?')) return;
    try {
      await api(`/api/threads/${currentId}`, { method: 'DELETE' });
      const rest = (threads ?? []).filter((t) => t.id !== currentId);
      setThreads(rest);
      clear();
      setCurrentId(rest[0]?.id ?? null);
      if (rest[0]) await load(rest[0].id);
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  };

  return { threads, currentId, currentThread, pendingModel, chat, send, changeModel, newThread, selectThread, deleteThread };
}

const threadText = (items: ChatItem[]) =>
  items
    .filter((m) => m.content)
    .map((m) => `**${m.role === 'user' ? '나' : 'AI'}**: ${m.content}`)
    .join('\n\n');

function DiscussionSection({ talk, open, onOpenChange }: { talk: Discussion; open: boolean; onOpenChange(on: boolean): void }) {
  const { jumpToPage } = useViewer();
  const copy = useCopy();
  const { threads, currentId, chat } = talk;

  return (
    <OverviewSection
      id="discussion"
      title="토론"
      open={open}
      onOpenChange={onOpenChange}
      actions={
        <>
          <button className={smallIconBtnCls} aria-label="토론 복사" title="복사" disabled={!chat.items.length} onClick={() => copy(threadText(chat.items))}>
            <Copy size={14} />
          </button>
          <button className={smallIconBtnCls} aria-label="새 토론" title="새 토론" disabled={chat.busy} onClick={() => void talk.newThread()}>
            <Plus size={15} />
          </button>
        </>
      }
    >
      <div className="flex items-center gap-1">
        <div className="relative min-w-0 flex-1">
          <MessageCircle size={14} aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-muted" />
          <select
            aria-label="토론 선택"
            className="h-9 w-full appearance-none truncate rounded-lg border border-line bg-surface pr-8 pl-8 text-[13px] text-fg disabled:opacity-60"
            value={currentId ?? ''}
            disabled={chat.busy || !threads?.length}
            onChange={(e) => talk.selectThread(e.target.value)}
          >
            {!threads?.length && <option value="">토론 없음</option>}
            {threads?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
          <ChevronDown size={14} aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-fg-muted" />
        </div>
        {currentId && (
          <button className={smallIconBtnCls} aria-label="토론 삭제" title="토론 삭제" disabled={chat.busy} onClick={() => void talk.deleteThread()}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {!chat.items.length ? (
        <p className="mt-3 text-[13px] leading-relaxed text-fg-muted">
          논문에 대해 물어보세요. PDF에서 글을 선택해 설명·질문을 누르거나, {ALT_KEY} 드래그로 고른 영역에서 설명을 눌러도 됩니다.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-4">
          {chat.items.map((m) => (
            <ChatBubble key={m.id} m={m} onJump={jumpToPage} />
          ))}
        </ul>
      )}
    </OverviewSection>
  );
}
