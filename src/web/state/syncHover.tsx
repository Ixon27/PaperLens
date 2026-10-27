import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

/** The aligned sentence under the pointer in the PDF or the translation. */
export interface SyncHover {
  block: number;
  sentence: number;
  from: 'pdf' | 'translation';
}

interface SyncHoverState {
  hover: SyncHover | null;
  setHover(h: SyncHover | null): void;
  /** Clear the hover only if `from` set it last (leaving one side must not undo the other side's new hover). */
  clearHover(from: SyncHover['from']): void;
  /** The latest hover, including one set earlier in the same event that has not rendered yet. */
  current(): SyncHover | null;
}

// Separate from the viewer context: hovering must not re-render every panel that reads useViewer.
const SyncHoverContext = createContext<SyncHoverState | null>(null);

export function SyncHoverProvider({ children }: { children: ReactNode }) {
  const [hover, setState] = useState<SyncHover | null>(null);
  // Moving between panes fires the entered side's handler before the left side's `mouseleave`.
  const latest = useRef<SyncHover | null>(null);
  const setHover = useCallback((h: SyncHover | null) => {
    latest.current = h;
    setState(h);
  }, []);
  const clearHover = useCallback(
    (from: SyncHover['from']) => {
      if (latest.current?.from === from) setHover(null);
    },
    [setHover],
  );
  const current = useCallback(() => latest.current, []);
  const value = useMemo(() => ({ hover, setHover, clearHover, current }), [hover, setHover, clearHover, current]);
  return <SyncHoverContext.Provider value={value}>{children}</SyncHoverContext.Provider>;
}

export function useSyncHover(): SyncHoverState {
  const v = useContext(SyncHoverContext);
  if (!v) throw new Error('useSyncHover must be used inside SyncHoverProvider');
  return v;
}
