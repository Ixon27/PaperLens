import { useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'pr.theme';
const listeners = new Set<() => void>();
const darkQuery = () => matchMedia('(prefers-color-scheme: dark)');
const emit = () => {
  for (const l of listeners) l();
};

export function readThemePref(): ThemePref {
  const saved = localStorage.getItem(KEY);
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

/** The theme on screen now ('system' resolved). */
function readResolved(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function paint(pref: ThemePref) {
  document.documentElement.dataset.theme = pref === 'system' ? (darkQuery().matches ? 'dark' : 'light') : pref;
  emit();
}

function store(pref: ThemePref) {
  localStorage.setItem(KEY, pref);
  paint(pref);
}

/**
 * Paints the theme before first render and follows the OS while on 'system'. The desktop app's web
 * storage does not outlive a launch: its main process keeps the choice and has already applied it
 * to the window, so `prefers-color-scheme` paints the right first frame until the choice arrives.
 */
export function initTheme() {
  paint(readThemePref());
  darkQuery().addEventListener('change', () => paint(readThemePref()));
  void window.paperReaderDesktop?.getTheme().then(store, () => {});
}

export function setThemePref(pref: ThemePref) {
  store(pref);
  // Back on 'system', the OS appearance applies once the window drops its forced theme.
  void window.paperReaderDesktop?.setTheme(pref).then(() => paint(readThemePref()));
}

/** Switch to the opposite of what is on screen (leaving 'system' for an explicit choice). */
export function toggleTheme() {
  setThemePref(readResolved() === 'dark' ? 'light' : 'dark');
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, readThemePref);
}

export function useResolvedTheme(): 'light' | 'dark' {
  return useSyncExternalStore(subscribe, readResolved);
}
