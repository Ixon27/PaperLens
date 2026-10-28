import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { findQuote } from '../../shared/quote-match';
import { usePaper } from '../state/paper';
import { useViewer } from '../state/viewer';

export function SourceChip({ page, endPage, label, quote, onNavigate }: { page: number; endPage: number | null; label: string; quote: string | null; onNavigate?: () => void }) {
  const { blocks } = usePaper();
  const { jumpToPage, scrollToBlock, revealSource } = useViewer();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const tooltipId = useId();

  const hide = () => {
    clearTimeout(timer.current);
    setPosition(null);
  };
  const show = () => {
    if (!quote) return;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) setPosition({ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)) });
    }, 150);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const jump = () => {
    if (quote && blocks) {
      const hit = findQuote(blocks, page, endPage, quote);
      const block = hit && blocks.find((b) => b.idx === hit.idx);
      if (hit && block) {
        if (block.spans.length) revealSource(block, hit.start, hit.end);
        else scrollToBlock(block);
        return;
      }
    }
    jumpToPage(page);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="mx-0.5 inline-flex items-center rounded bg-accent-soft px-1.5 py-0 align-baseline text-[11.5px] font-medium text-accent ring-1 ring-accent/30 transition-colors duration-150 hover:bg-accent/20"
        title={`${page}쪽으로 이동`}
        aria-describedby={position ? tooltipId : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onNavigate?.(); jump(); }}
      >
        {label}{quote && <span aria-hidden="true"> “</span>}
      </button>
      {position && quote && createPortal(
        <div id={tooltipId} role="tooltip" className="pointer-events-none fixed z-[110] max-w-[320px] rounded-lg bg-raised p-2 text-[12.5px] shadow-pop" style={position}>
          <div className="italic">“{quote}”</div>
          <div className="mt-1 text-fg-dim">p.{page} · 클릭하면 원문 위치로 이동</div>
        </div>,
        document.body,
      )}
    </>
  );
}
