import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { btnCls, primaryBtnCls } from '../components/Dialog';
import { JobBar } from '../components/JobBar';
import { useToast } from '../components/Toast';
import { usePaper } from '../state/paper';
import { useJob } from '../state/useJob';
import { useViewer } from '../state/viewer';
import type { BlockDto } from '../types';

const WHEEL_QUIET_MS = 800;

export function TranslationPanel() {
  const { paper, blocks, setBlocks, reloadBlocks, reloadPaper } = usePaper();
  const { currentPage, tab, setHoverBlock, scrollToBlock } = useViewer();
  const toast = useToast();
  const [showOriginal, setShowOriginal] = useState(false);
  const [sync, setSync] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastWheelRef = useRef(0);

  const job = useJob('translation', {
    onEvent(event, data) {
      if (event === 'snapshot') {
        // Following an already-running job: pick up pages translated before we subscribed.
        void reloadBlocks();
      } else if (event === 'page') {
        const { translations } = data as { page: number; translations: Record<string, string> };
        setBlocks((list) => list && list.map((b) => (translations[String(b.idx)] !== undefined ? { ...b, ko: translations[String(b.idx)] } : b)));
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

  // Remember when the user last wheeled the panel's scroll container.
  useEffect(() => {
    const container = rootRef.current?.closest('[data-tab]');
    if (!container) return;
    const onWheel = () => {
      lastWheelRef.current = Date.now();
    };
    container.addEventListener('wheel', onWheel, { passive: true });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  // 동기 스크롤: follow the PDF's current page.
  useEffect(() => {
    if (!sync || tab !== 'translation' || Date.now() - lastWheelRef.current < WHEEL_QUIET_MS) return;
    const target = [...pages].reverse().find(([p]) => p <= currentPage)?.[0];
    if (target === undefined) return;
    rootRef.current?.querySelector(`[data-page="${target}"]`)?.scrollIntoView({ block: 'start' });
  }, [currentPage, sync, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (force: boolean) => {
    if (force && !confirm('기존 번역을 모두 지우고 다시 번역할까요?')) return;
    try {
      const { jobId } = await api<{ jobId: string }>(`/api/papers/${paper.id}/translation`, { method: 'POST', json: { force } });
      if (force) setBlocks((list) => list && list.map((b) => ({ ...b, ko: null })));
      job.attach(jobId);
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  };

  if (!blocks || !total) {
    return (
      <div ref={rootRef} className={`p-6 text-[13px] ${blocks ? 'text-stone-500' : 'text-stone-400'}`}>
        {blocks ? '번역할 문단이 없습니다.' : '불러오는 중…'}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="pb-6">
      <div className="sticky top-0 z-10 flex flex-col gap-2 border-b border-stone-200 bg-white/95 px-3 py-2 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          {!job.running &&
            (done === 0 ? (
              <button className={primaryBtnCls} onClick={() => void start(false)}>
                번역 시작
              </button>
            ) : done < total ? (
              <button className={primaryBtnCls} onClick={() => void start(false)}>
                이어서 번역
              </button>
            ) : (
              <button className={btnCls} onClick={() => void start(true)}>
                다시 번역
              </button>
            ))}
          <span className="text-[12px] tabular-nums text-stone-500">
            {done}/{total} 문단
          </span>
          <label className="ml-auto flex items-center gap-1 text-[12px] text-stone-600">
            <input type="checkbox" checked={showOriginal} onChange={(e) => setShowOriginal(e.target.checked)} />
            원문 함께 보기
          </label>
          <label className="flex items-center gap-1 text-[12px] text-stone-600">
            <input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} />
            동기 스크롤
          </label>
        </div>
        <JobBar job={job.job} onCancel={() => void job.cancel()} />
        {job.job?.status === 'done' && job.job.message && <div className="text-[12px] text-amber-700">{job.job.message}</div>}
      </div>

      {pages.map(([page, list]) => (
        <section key={page} className="px-3">
          <h3 id={`tr-p-${page}`} data-page={page} className="scroll-mt-24 pt-4 pb-1.5 text-[12px] font-bold text-stone-500">
            p.{page}
          </h3>
          <ul className="flex flex-col gap-2">
            {list.map((b) => (
              <li
                key={b.idx}
                className="cursor-pointer rounded-md border border-stone-200 bg-white px-3 py-2 hover:border-blue-300 hover:bg-blue-50/40"
                onMouseEnter={() => setHoverBlock(b)}
                onMouseLeave={() => setHoverBlock(null)}
                onClick={() => {
                  // the PDF scroll this causes must not yank the panel back to the page header
                  lastWheelRef.current = Date.now();
                  scrollToBlock(b);
                }}
              >
                {b.ko ? (
                  <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-stone-800">{b.ko}</p>
                ) : (
                  <p className="text-[13px] text-stone-400">
                    … {b.text.slice(0, 80)}
                  </p>
                )}
                {showOriginal && <p className="mt-1.5 text-[11.5px] leading-snug text-stone-400">{b.text}</p>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
