import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { reducedMotion } from './motion';

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
  link?: { label: string; href: string };
  closing: boolean;
}

type ShowToast = (message: string, opts?: { tone?: 'info' | 'error'; link?: { label: string; href: string } }) => void;

const ToastContext = createContext<ShowToast>(() => {});

const EXIT_MS = 160;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback<ShowToast>((message, opts) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone: opts?.tone ?? 'info', link: opts?.link, closing: false }]);
    setTimeout(() => {
      setToasts((t) => t.map((x) => (x.id === id ? { ...x, closing: true } : x)));
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), reducedMotion() ? 0 : EXIT_MS);
    }, opts?.link ? 9000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="pointer-events-none fixed bottom-5 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            data-closing={t.closing || undefined}
            className={`pr-toast pointer-events-auto max-w-[560px] rounded-full px-4 py-2 text-[13px] shadow-pop ${
              t.tone === 'error' ? 'bg-danger text-white' : 'bg-inverse text-inverse-fg'
            }`}
          >
            <span className="break-words">{t.message}</span>
            {t.link && (
              <a className="ml-3 font-semibold underline" href={t.link.href}>
                {t.link.label}
              </a>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ShowToast {
  return useContext(ToastContext);
}

/** Copy text to the clipboard and confirm with a toast. */
export function useCopy(): (text: string) => void {
  const toast = useToast();
  return useCallback(
    (text: string) =>
      void navigator.clipboard.writeText(text).then(
        () => toast('복사했습니다'),
        () => toast('복사하지 못했습니다', { tone: 'error' }),
      ),
    [toast],
  );
}
