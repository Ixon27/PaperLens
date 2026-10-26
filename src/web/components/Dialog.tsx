import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Modal shell: backdrop click and Esc close it. */
export function Dialog({ title, onClose, children, footer, width = 520 }: { title: string; onClose(): void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-black/30 p-6 pt-[8vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className="flex max-h-[84vh] w-full flex-col rounded-xl bg-white shadow-2xl"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center border-b border-stone-200 px-5 py-3">
          <h2 className="flex-1 text-[15px] font-bold">{title}</h2>
          <button className="text-stone-400 hover:text-stone-700" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-stone-200 px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export const inputCls =
  'w-full rounded-md border border-stone-300 px-2.5 py-1.5 text-[13px] outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100';
export const btnCls = 'rounded-md border border-stone-300 bg-white px-3 py-1.5 text-[13px] hover:bg-stone-100 disabled:opacity-50';
export const primaryBtnCls = 'rounded-md bg-stone-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-stone-700 disabled:opacity-50';

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-[12px] font-semibold text-stone-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-stone-500">{hint}</span>}
    </label>
  );
}
