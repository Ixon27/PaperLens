import { useEffect, useState } from 'react';

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Keeps a closed element mounted with `closing: true` for `exitMs` so its exit transition can play,
 * then unmounts it. Reopening during the exit cancels it.
 */
export function usePresence(open: boolean, exitMs: number): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const delay = reducedMotion() ? 0 : exitMs;
    if (delay === 0) {
      setMounted(false);
      return;
    }
    const timer = setTimeout(() => setMounted(false), delay);
    return () => clearTimeout(timer);
  }, [open, exitMs]);
  return { mounted: open || mounted, closing: !open && mounted };
}
