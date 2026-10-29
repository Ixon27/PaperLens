import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { reducedMotion } from './motion';

const EXIT_MS = 150;

/**
 * Modal shell. Esc, a backdrop press and ✕ play the exit animation, then call `onClose`.
 * `footer` may be a function receiving that animated close (for 취소-style buttons).
 */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  width = 520,
  dismissible = true,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode | ((close: () => void) => ReactNode);
  width?: number;
  dismissible?: boolean;
}) {
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const requestClose = useCallback(() => {
    if (!dismissible || closingRef.current) return;
    closingRef.current = true;
    if (reducedMotion()) {
      onCloseRef.current();
      return;
    }
    setClosing(true);
    timer.current = setTimeout(() => onCloseRef.current(), EXIT_MS);
  }, [dismissible]);

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose]);

  const footerNode = typeof footer === 'function' ? footer(requestClose) : footer;
  return createPortal(
    <div
      className="pr-scrim fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-scrim p-6 pt-[10vh]"
      data-closing={closing || undefined}
      onMouseDown={requestClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="pr-dialog flex max-h-[80vh] w-full flex-col rounded-2xl border border-line bg-raised shadow-pop"
        data-closing={closing || undefined}
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 pt-4 pb-3">
          <h2 className="flex-1 text-[15px] font-semibold text-fg">{title}</h2>
          <button className={`${iconBtnCls} -mr-2`} onClick={requestClose} disabled={!dismissible} aria-label="닫기">
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>
        {footerNode && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footerNode}</div>}
      </div>
    </div>,
    document.body,
  );
}

const BTN_CORE =
  'inline-flex items-center justify-center gap-1.5 transition-[transform,background-color,color,border-color,opacity] duration-150 ease-out disabled:opacity-50 disabled:pointer-events-none';
const BTN_BASE = `${BTN_CORE} active:scale-[0.97]`;

export const btnCls = `${BTN_BASE} h-8 rounded-lg border border-line-strong bg-surface px-3 text-[13px] text-fg hover:bg-hover`;
export const primaryBtnCls = `${BTN_BASE} h-8 rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-fg hover:opacity-90`;
export const ghostBtnCls = `${BTN_BASE} h-8 rounded-lg px-2.5 text-[13px] text-fg-muted hover:bg-hover hover:text-fg`;
export const dangerBtnCls = `${BTN_BASE} h-8 rounded-lg bg-danger px-3 text-[13px] font-medium text-white hover:opacity-90`;
export const smallDangerBtnCls = `${BTN_BASE} h-7 rounded-md bg-danger px-3 text-[12px] font-medium text-white hover:opacity-90`;
export const smallBtnCls = `${BTN_BASE} h-7 rounded-md border border-line-strong bg-surface px-2 text-[12px] text-fg hover:bg-hover`;
export const smallPrimaryBtnCls = `${BTN_BASE} h-7 rounded-md bg-accent px-2.5 text-[12px] font-medium text-accent-fg hover:opacity-90`;
export const smallGhostBtnCls = `${BTN_BASE} h-7 rounded-md px-2 text-[12px] text-fg-muted hover:bg-hover hover:text-fg`;
export const iconBtnCls = `${BTN_CORE} h-8 w-8 rounded-lg text-fg-muted hover:bg-hover hover:text-fg active:scale-[0.95]`;
export const smallIconBtnCls = `${BTN_CORE} h-7 w-7 shrink-0 rounded-md text-fg-muted hover:bg-hover hover:text-fg active:scale-[0.95]`;

const CHIP = 'inline-flex items-center gap-1 h-7 whitespace-nowrap rounded-full border px-2.5 text-[12px] transition-colors duration-150';

/** Pill toggle (폭 맞춤, 영역 선택, 번역 …); pair with `aria-pressed`. */
export function chipCls(on: boolean): string {
  return on ? `${CHIP} border-accent/50 bg-accent-soft text-accent` : `${CHIP} border-line text-fg-muted hover:bg-hover hover:text-fg`;
}

export const inputCls =
  'w-full rounded-lg border border-line-strong bg-sunken px-3 py-2 text-[13px] text-fg placeholder:text-fg-dim outline-none transition-[border-color,box-shadow] duration-150 focus:border-focus focus:ring-2 focus:ring-focus/25';

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-[12.5px] font-medium text-fg">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] leading-relaxed text-fg-muted">{hint}</span>}
    </label>
  );
}
