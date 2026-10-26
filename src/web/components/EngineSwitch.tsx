import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Settings } from '../types';
import { useToast } from './Toast';

type Engine = Settings['engine'];

export function EngineSwitch() {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [available, setAvailable] = useState<Record<Engine, boolean>>({ claude: true, codex: true });
  const toast = useToast();

  useEffect(() => {
    void api<Settings>('/api/settings').then((s) => setEngine(s.engine));
    void api<Record<Engine, boolean>>('/api/engines').then(setAvailable);
    const onChange = (e: Event) => setEngine((e as CustomEvent<Engine>).detail);
    window.addEventListener('pr:engine', onChange);
    return () => window.removeEventListener('pr:engine', onChange);
  }, []);

  const choose = async (next: Engine) => {
    if (next === engine) return;
    const prev = engine;
    setEngine(next);
    try {
      await api('/api/settings', { method: 'PUT', json: { engine: next } });
      window.dispatchEvent(new CustomEvent('pr:engine', { detail: next }));
    } catch (e) {
      setEngine(prev);
      toast((e as Error).message, { tone: 'error' });
    }
  };

  return (
    <div className="inline-flex overflow-hidden rounded-md border border-stone-300 text-[12px]" role="radiogroup" aria-label="AI 엔진">
      {(['claude', 'codex'] as const).map((e) => (
        <button
          key={e}
          role="radio"
          aria-checked={engine === e}
          disabled={!available[e]}
          title={available[e] ? undefined : 'CLI 없음'}
          onClick={() => void choose(e)}
          className={`px-2.5 py-1 ${engine === e ? 'bg-stone-800 text-white' : 'bg-white text-stone-700 hover:bg-stone-100'} disabled:cursor-not-allowed disabled:opacity-40`}
        >
          {e === 'claude' ? 'Claude' : 'Codex'}
        </button>
      ))}
    </div>
  );
}
