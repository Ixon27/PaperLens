import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { btnCls, chipCls, primaryBtnCls, smallPrimaryBtnCls } from '../components/Dialog';
import { isCancelled, JobBar } from '../components/JobBar';
import { ModelBadge, formatMadeBy } from '../components/ModelBadge';
import { TermCard } from '../components/TermCard';
import { useToast } from '../components/Toast';
import { useModelCatalog } from '../state/models';
import { usePaper } from '../state/paper';
import { useSyncHover, type SyncHover } from '../state/syncHover';
import { useJob } from '../state/useJob';
import { useViewer } from '../state/viewer';
import type { BlockDto, KoSentence } from '../types';
import type { MadeBy } from '../../shared/models';

const WHEEL_QUIET_MS = 800;

const BLOCK_CLS = '[word-break:keep-all] [overflow-wrap:anywhere] cursor-pointer';
const KIND_CLS: Record<BlockDto['kind'], string> = {
  heading: 'px-5 pt-3 pb-1 text-[15.5px] font-semibold leading-snug text-fg',
  body: 'px-5 py-1.5 text-[15px] leading-[1.85] text-fg',
  caption: 'mx-5 my-2 rounded-lg bg-sunken px-3 py-2 text-[13px] leading-relaxed text-fg-muted',
  aside: 'px-5 py-1.5 text-[15px] leading-[1.85] text-fg',
};
const UNIT_CLS = 'rounded-[3px] transition-colors duration-100';

/** The aligned sentence index, or nothing. */
type Lit = number | null;

const TranslatedBlock = memo(function TranslatedBlock({
  b,
  lit,
  onHover,
  onOpen,
}: {
  b: BlockDto;
  lit: Lit;
  onHover(h: SyncHover | null): void;
  onOpen(b: BlockDto): void;
}) {
  let content;
  if (!b.ko) {
    content = (
      <p className="px-5 py-1.5 text-[13px] text-fg-dim">
        {b.text.slice(0, 120)}
        {b.text.length > 120 && '…'}
      </p>
    );
  } else if (b.koSentences) {
    content = (
      <p className={KIND_CLS[b.kind]} onMouseLeave={() => onHover(null)}>
        {b.koSentences.map((s, i) => (
          <span key={i}>
            {i > 0 && ' '}
            <span
              data-s={i}
              className={`${UNIT_CLS} ${lit === i ? 'bg-accent-soft' : ''}`}
              onMouseEnter={() => onHover({ block: b.idx, sentence: i, from: 'translation' })}
            >
              {s.ko}
            </span>
          </span>
        ))}
      </p>
    );
  } else {
    content = (
      <p className={KIND_CLS[b.kind]} title="원문과 문장 구분이 달라 문장 연결을 표시하지 않습니다.">
        {b.ko}
      </p>
    );
  }
  return (
    <div data-block={b.idx} className={BLOCK_CLS} onClick={() => onOpen(b)}>
      {content}
    </div>
  );
});

const TERM_MAX = 80;
const CARD_W = 340;

/**
 * Selecting up to 80 characters in the translation offers 용어 설명; the explanation is saved to the
 * vocabulary. Dismissed by a press elsewhere, Esc or scrolling the pane.
 */
function TermPicker({ scrollRef, paperId, pageOf }: { scrollRef: RefObject<HTMLDivElement | null>; paperId: string; pageOf(idx: number): number | null }) {
  const [pick, setPick] = useState<{ text: string; x: number; top: number; bottom: number; page: number | null; open: boolean } | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pageOfRef = useRef(pageOf);
  pageOfRef.current = pageOf;

  useEffect(() => {
    const pane = scrollRef.current;
    if (!pane) return;
    const onMouseUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!pane.contains(range.commonAncestorContainer)) return;
      const text = sel.toString().replace(/\s+/g, ' ').trim();
      if (!text || text.length > TERM_MAX) return;
      const rects = range.getClientRects();
      const rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
      const start = range.startContainer;
      const blockEl = (start instanceof Element ? start : start.parentElement)?.closest('[data-block]');
      const page = blockEl ? pageOfRef.current(Number(blockEl.getAttribute('data-block'))) : null;
      setPick({ text, x: rect.right, top: rect.top, bottom: rect.bottom, page, open: false });
    };
    pane.addEventListener('mouseup', onMouseUp);
    return () => pane.removeEventListener('mouseup', onMouseUp);
  }, [scrollRef]);

  useEffect(() => {
    if (!pick) return;
    const pane = scrollRef.current;
    const dismiss = () => setPick(null);
    const onDown = (e: PointerEvent) => {
      if (!popRef.current?.contains(e.target as Node)) dismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    pane?.addEventListener('scroll', dismiss, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
      pane?.removeEventListener('scroll', dismiss);
    };
  }, [pick, scrollRef]);

  if (!pick) return null;
  const left = Math.max(8, Math.min(pick.x - (pick.open ? CARD_W / 2 : 0), window.innerWidth - (pick.open ? CARD_W + 16 : 96)));
  // Low on the screen, the card opens upward.
  const pos: CSSProperties =
    pick.open && pick.bottom > window.innerHeight * 0.6 ? { left, bottom: window.innerHeight - pick.top + 6 } : { left, top: pick.bottom + 6 };
  return createPortal(
    <div ref={popRef} className="fixed z-[80]" style={pos}>
      {pick.open ? (
        <div className="pr-tip rounded-xl border border-line bg-raised shadow-pop">
          <TermCard paperId={paperId} term={pick.text} page={pick.page} />
        </div>
      ) : (
        <button className={`${smallPrimaryBtnCls} pr-tip shadow-pop`} onClick={() => setPick((p) => p && { ...p, open: true })}>
          용어 설명
        </button>
      )}
    </div>,
    document.body,
  );
}

export function TranslationPane() {
  const { paper, blocks, setBlocks, reloadBlocks, reloadPaper } = usePaper();
  const { currentPage, numPages, scrollToBlock } = useViewer();
  const { hover, setHover, clearHover } = useSyncHover();
  const { catalog } = useModelCatalog();
  const toast = useToast();
  const [sync, setSync] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastWheelRef = useRef(0);

  const job = useJob('translation', {
    onEvent(event, data) {
      if (event === 'snapshot') {
        // Following an already-running job: pick up pages translated before we subscribed.
        void reloadBlocks();
      } else if (event === 'page') {
        const { translations } = data as { page: number; translations: Record<string, { ko: string; sentences: KoSentence[] | null; by: MadeBy }> };
        setBlocks((list) =>
          list &&
          list.map((b) => {
            const t = translations[String(b.idx)];
            return t ? { ...b, ko: t.ko, koSentences: t.sentences, by: t.by } : b;
          }),
        );
      }
    },
    onFinish() {
      void reloadBlocks();
      void reloadPaper();
    },
  });

  const pages = useMemo(() => {
    const map = new Map<number, BlockDto[]>();
    for (const b of blocks ?? []) {
      if (!b.translatable) continue;
      map.set(b.page, [...(map.get(b.page) ?? []), b]);
    }
    return [...map.entries()].sort(([a], [b]) => a - b);
  }, [blocks]);
  const total = pages.reduce((n, [, list]) => n + list.length, 0);
  const done = pages.reduce((n, [, list]) => n + list.filter((b) => b.ko).length, 0);
  const unaligned = pages.reduce((n, [, list]) => n + list.filter((b) => b.ko && (!b.koSentences?.length || !b.spans.length)).length, 0);

  const models = useMemo(() => {
    const seen = new Map<string, MadeBy>();
    for (const b of blocks ?? []) if (b.ko && b.by) seen.set(JSON.stringify(b.by), b.by);
    return [...seen.values()];
  }, [blocks]);

  // Remember when the user last wheeled the pane.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const onWheel = () => {
      lastWheelRef.current = Date.now();
    };
    container.addEventListener('wheel', onWheel, { passive: true });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  // 스크롤 연동: follow the PDF's current page unless the user is scrolling the pane.
  useEffect(() => {
    if (!sync || Date.now() - lastWheelRef.current < WHEEL_QUIET_MS) return;
    const target = [...pages].reverse().find(([p]) => p <= currentPage)?.[0];
    if (target === undefined) return;
    // scroll-margin keeps the page header clear of the sticky toolbar.
    scrollRef.current?.querySelector(`[data-page="${target}"]`)?.scrollIntoView({ block: 'start' });
  }, [currentPage, sync]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Entering a sentence takes the hover; leaving clears it only if this pane set it. */
  const onHover = useCallback(
    (h: SyncHover | null) => {
      if (h) setHover(h);
      else clearHover('translation');
    },
    [setHover, clearHover],
  );

  const onOpen = useCallback(
    (b: BlockDto) => {
      // The end of a text selection is also a click; selecting must not jump the PDF.
      if (!window.getSelection()?.isCollapsed) return;
      // The PDF scroll this causes must not yank the pane back to the page header.
      lastWheelRef.current = Date.now();
      scrollToBlock(b);
    },
    [scrollToBlock],
  );

  const start = async (force: boolean) => {
    if (force && !confirm('기존 번역을 모두 지우고 다시 번역할까요?')) return;
    try {
      const { jobId } = await api<{ jobId: string }>(`/api/papers/${paper.id}/translation`, { method: 'POST', json: { force } });
      if (force) setBlocks((list) => list && list.map((b) => ({ ...b, ko: null, koSentences: null, by: null })));
      job.attach(jobId);
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  };

  if (!blocks || !total) {
    return (
      <div ref={scrollRef} className={`h-full overflow-y-auto p-6 text-[13px] ${blocks ? 'text-fg-muted' : 'text-fg-dim'}`}>
        {blocks ? '번역할 문단이 없습니다.' : '불러오는 중…'}
      </div>
    );
  }

  const litOf = (b: BlockDto): Lit => (hover?.block === b.idx ? hover.sentence : null);
  const pageCount = numPages || paper.pageCount;
  const pageOf = (idx: number) => blocks.find((b) => b.idx === idx)?.page ?? null;

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto pb-10">
      <TermPicker scrollRef={scrollRef} paperId={paper.id} pageOf={pageOf} />
      <div className="sticky top-0 z-10 border-b border-line bg-surface/85 px-4 py-2 backdrop-blur-md">
        <div className="flex flex-nowrap items-center gap-2">
          {!job.running &&
            (done === 0 ? (
              <button className={`${primaryBtnCls} shrink-0`} onClick={() => void start(false)}>
                번역 시작
              </button>
            ) : done < total ? (
              <button className={`${primaryBtnCls} shrink-0`} onClick={() => void start(false)}>
                이어서 번역
              </button>
            ) : (
              <button className={`${btnCls} shrink-0`} onClick={() => void start(true)}>
                다시 번역
              </button>
            ))}
          <span className="min-w-0 truncate font-mono text-[12px] whitespace-nowrap tabular-nums text-fg-muted" title={`${done}/${total} 문단`}>
            {done}/{total} 문단
          </span>
          <span className="flex min-w-0 items-center gap-2 truncate">
            {unaligned > 0 && (
              <span className="truncate text-[11px] text-fg-dim" title="문장 구분이나 PDF 좌표를 연결할 수 없는 번역은 문단 전체를 강조하지 않습니다.">
                문장 연결 없음 {unaligned}개
              </span>
            )}
            {models.length === 1 ? (
              <ModelBadge by={models[0]} />
            ) : (
              models.length > 1 && (
                <span className="truncate text-[11px] text-fg-dim" title={models.map((m) => formatMadeBy(m, catalog)).join('\n')}>
                  여러 모델
                </span>
              )
            )}
          </span>
          <button
            className={`${chipCls(sync)} ml-auto shrink-0`}
            aria-pressed={sync}
            title="번역 열이 PDF의 현재 쪽을 따라갑니다"
            onClick={() => setSync((v) => !v)}
          >
            스크롤 연동
          </button>
        </div>
        {job.running || (job.job?.status === 'error' && !isCancelled(job.job)) ? (
          <div className="mt-2">
            <JobBar job={job.job} onCancel={() => void job.cancel()} />
          </div>
        ) : (
          job.job?.status === 'done' && job.job.message && <div className="mt-1.5 text-[12px] text-warning">{job.job.message}</div>
        )}
      </div>

      {pages.map(([page, list]) => (
        <section key={page} data-page={page} className="scroll-mt-16">
          <div className="flex items-center gap-3 px-5 pt-6 pb-2">
            <span className="font-mono text-[11.5px] text-fg-dim">
              {page} / {pageCount}
            </span>
            <span className="h-px flex-1 bg-line" />
          </div>
          {list.map((b) => (
            <TranslatedBlock key={b.idx} b={b} lit={litOf(b)} onHover={onHover} onOpen={onOpen} />
          ))}
        </section>
      ))}
    </div>
  );
}
