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
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap transition-[background-color,color,border-color,opacity] duration-150 ease-out disabled:opacity-50 disabled:pointer-events-none';
const BTN_BASE = `${BTN_CORE} active:opacity-75`;

export const btnCls = `${BTN_BASE} h-7 rounded-lg border border-line bg-surface px-2.5 text-[12.5px] font-medium text-fg hover:bg-raised shadow-[inset_0_1px_0_#ffffff40]`;
export const primaryBtnCls = `${BTN_BASE} h-7 rounded-lg border border-transparent bg-accent px-2.5 text-[12.5px] font-medium text-white shadow-[inset_0_1px_0_#ffffff40,0_4px_12px_-4px_#2862e099] hover:opacity-90`;
export const ghostBtnCls = `${BTN_BASE} h-8 rounded-lg px-2.5 text-[13px] text-fg-muted hover:bg-hover hover:text-fg`;
export const dangerBtnCls = `${BTN_BASE} h-8 rounded-lg bg-danger px-3 text-[13px] font-medium text-white hover:opacity-90`;
export const smallDangerBtnCls = `${BTN_BASE} h-7 rounded-md bg-danger px-3 text-[12px] font-medium text-white hover:opacity-90`;
export const smallBtnCls = `${BTN_BASE} h-7 rounded-md border border-line-strong bg-surface px-2 text-[12px] text-fg hover:bg-hover`;
export const smallPrimaryBtnCls = `${BTN_BASE} h-6 rounded-lg bg-accent px-2 text-[11.5px] font-medium text-white hover:opacity-90`;
export const smallGhostBtnCls = `${BTN_BASE} h-7 rounded-lg px-2 text-[12px] text-fg-muted hover:bg-hover hover:text-fg`;
export const iconBtnCls = `${BTN_CORE} h-7 w-7 rounded-lg text-fg-muted hover:bg-hover hover:text-fg active:opacity-70`;
export const smallIconBtnCls = `${BTN_CORE} h-[26px] w-[26px] shrink-0 rounded-[7px] text-fg-muted hover:bg-hover hover:text-fg active:opacity-70`;

const CHIP = 'inline-flex items-center gap-1 h-7 whitespace-nowrap rounded-md border px-2.5 text-[12px] transition-colors duration-150';

/** Compact outlined toggle; pair with `aria-pressed`. */
export function chipCls(on: boolean): string {
  return on ? `${CHIP} border-line-strong bg-surface text-fg` : `${CHIP} border-transparent text-fg-muted hover:bg-hover hover:text-fg`;
}

export const inputCls =
  'w-full rounded-[9px] border border-line-strong bg-sunken px-2.5 py-[7px] text-[13px] text-fg placeholder:text-fg-dim outline-none transition-[border-color,box-shadow] duration-150 focus:border-focus focus:ring-[3px] focus:ring-focus/12';

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-[12.5px] font-medium text-fg">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] leading-relaxed text-fg-muted">{hint}</span>}
    </label>
  );
}
