import { db } from './db';

export type Engine = 'claude' | 'codex';

export interface Settings {
  engine: Engine;
  claude: { quickModel: string; heavyModel: string };
  codex: { model: string; quickEffort: string; heavyEffort: string };
  readerContext: string;
}

export const DEFAULT_SETTINGS: Settings = {
  engine: 'claude',
  claude: { quickModel: 'sonnet', heavyModel: 'opus' },
  codex: { model: 'gpt-6.1-sol', quickEffort: 'low', heavyEffort: 'high' },
  readerContext:
    '미생물학 대학원생. 관심 분야: 장내 마이크로바이옴, 마이크로바이옴 일반, 환경독성 × 마이크로바이옴, 계산·AI 생명과학. 전공 용어는 알지만 다른 분야 방법론은 낯설다.',
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursively overlay `over` onto `base`; only keys present in `base` are kept. */
function deepMerge<T>(base: T, over: unknown): T {
  if (!isObject(base) || !isObject(over)) return (over === undefined || over === null ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(base)) {
    if (key in over) out[key] = deepMerge((base as Record<string, unknown>)[key], over[key]);
  }
  return out as T;
}

export function getSettings(): Settings {
  const row = db.prepare("SELECT value FROM settings WHERE key='app'").get() as { value: string } | undefined;
  let stored: unknown = {};
  if (row) {
    try {
      stored = JSON.parse(row.value);
    } catch {
      stored = {};
    }
  }
  return deepMerge(DEFAULT_SETTINGS, stored);
}

export function saveSettings(patch: unknown): Settings {
  const merged = deepMerge(getSettings(), patch);
  if (merged.engine !== 'claude' && merged.engine !== 'codex') merged.engine = 'claude';
  db.prepare("INSERT INTO settings(key,value) VALUES('app',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    JSON.stringify(merged),
  );
  return merged;
}
