import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../api';
import type { ModelCatalog } from '../../shared/models';

interface CatalogState {
  catalog: ModelCatalog | null;
  loading: boolean;
  error: string | null;
}

/** One CLI model catalog per app session, shared by every picker and model badge. Loading until the first fetch ends. */
let state: CatalogState = { catalog: null, loading: true, error: null };
let requested = false;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

const set = (patch: Partial<CatalogState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};

export function refreshCatalog(): Promise<void> {
  requested = true;
  inFlight ??= (async () => {
    set({ loading: true, error: null });
    try {
      set({ catalog: await api<ModelCatalog>('/api/models'), loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : '모델 목록을 불러오지 못했습니다' });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const snapshot = () => state;

export function useModelCatalog(): CatalogState & { refresh(): void } {
  const s = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => {
    if (!requested) void refreshCatalog();
  }, []);
  return { ...s, refresh: () => void refreshCatalog() };
}
