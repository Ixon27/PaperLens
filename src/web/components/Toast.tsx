import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
  link?: { label: string; href: string };
}

type ShowToast = (message: string, opts?: { tone?: 'info' | 'error'; link?: { label: string; href: string } }) => void;

const ToastContext = createContext<ShowToast>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback<ShowToast>((message, opts) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone: opts?.tone ?? 'info', link: opts?.link }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts?.link ? 9000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="pointer-events-none fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto max-w-[560px] rounded-lg px-4 py-2 text-[13px] shadow-lg ${
              t.tone === 'error' ? 'bg-red-600 text-white' : 'bg-stone-800 text-white'
            }`}
          >
            <span className="break-all">{t.message}</span>
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
