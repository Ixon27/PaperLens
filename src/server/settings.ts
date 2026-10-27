import { db } from './db';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { BIN, EMAIL, PATHS } from './config';
import { HttpError } from './http-error';

export type Engine = 'claude' | 'codex';

/** Per-engine model + effort for 빠른 작업 (quick) and 깊은 작업 (heavy). Empty effort: no flag. */
export interface EngineProfiles {
  quickModel: string;
  heavyModel: string;
  quickEffort: string;
  heavyEffort: string;
}

export interface Settings {
  engine: Engine;
  claude: EngineProfiles;
  /** Empty model: the Codex CLI default. */
  codex: EngineProfiles;
  readerContext: string;
  vaultPath: string | null;
  contactEmail: string;
  onboardingDone: boolean;
  /** Look for a newer release at most once a day. */
  updateCheck: boolean;
  /** A release version the reader closed the notice for. */
  dismissedUpdate: string;
}

export const DEFAULT_SETTINGS: Settings = {
  engine: BIN.claude ? 'claude' : BIN.codex ? 'codex' : 'claude',
  claude: { quickModel: 'sonnet', heavyModel: 'opus', quickEffort: '', heavyEffort: '' },
  codex: { quickModel: '', heavyModel: '', quickEffort: 'low', heavyEffort: 'high' },
  readerContext: '연구 논문을 한국어로 읽는 연구자. 전공 용어는 원어로 유지하고, 낯선 방법론은 쉽게 설명한다.',
  vaultPath: PATHS.vault,
  contactEmail: EMAIL ?? '',
  onboardingDone: false,
  updateCheck: true,
  dismissedUpdate: '',
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursively overlay `over` onto `base`; only keys present in `base` are kept. */
function deepMerge<T>(base: T, over: unknown): T {
  if (!isObject(base) || !isObject(over)) return (over === undefined ? base : over) as T;
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
  // Older settings stored one Codex model for both profiles.
  if (isObject(stored) && isObject(stored.codex) && typeof stored.codex.model === 'string' && stored.codex.quickModel === undefined) {
    stored = { ...stored, codex: { ...stored.codex, quickModel: stored.codex.model, heavyModel: stored.codex.model } };
  }
  return deepMerge(DEFAULT_SETTINGS, stored);
}

export function saveSettings(patch: unknown): Settings {
  if (!isObject(patch)) throw new HttpError(400, '설정은 객체 형식이어야 합니다');
  const merged = deepMerge(getSettings(), patch);
  if (typeof merged.readerContext !== 'string'
    || typeof merged.codex?.quickModel !== 'string' || typeof merged.codex.heavyModel !== 'string'
    || typeof merged.claude?.quickModel !== 'string' || !merged.claude.quickModel.trim()
    || typeof merged.claude.heavyModel !== 'string' || !merged.claude.heavyModel.trim()
    || typeof merged.onboardingDone !== 'boolean' || typeof merged.contactEmail !== 'string'
    || typeof merged.updateCheck !== 'boolean' || typeof merged.dismissedUpdate !== 'string') {
    throw new HttpError(400, '설정 값의 형식이 올바르지 않습니다');
  }
  // Efforts reach CLI arguments (Codex: `-c model_reasoning_effort="…"`), so only bare lowercase words pass.
  const efforts = [merged.claude.quickEffort, merged.claude.heavyEffort, merged.codex.quickEffort, merged.codex.heavyEffort];
  if (!efforts.every((e) => typeof e === 'string' && /^[a-z]*$/.test(e))) {
    throw new HttpError(400, 'AI 작업 수준 값이 올바르지 않습니다');
  }
  merged.contactEmail = merged.contactEmail.trim();
  if (merged.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(merged.contactEmail)) {
    throw new HttpError(400, '연락처 이메일을 확인하세요');
  }
  if (merged.vaultPath !== null) {
    if (typeof merged.vaultPath !== 'string') throw new HttpError(400, '볼트 경로를 확인하세요');
    const value = merged.vaultPath.trim();
    merged.vaultPath = value ? value === '~' || value.startsWith('~/') ? join(homedir(), value.slice(1)) : value : null;
    if (merged.vaultPath && (!isAbsolute(merged.vaultPath) || !existsSync(merged.vaultPath) || !statSync(merged.vaultPath).isDirectory())) {
      throw new HttpError(400, 'Obsidian 볼트 폴더를 찾을 수 없습니다');
    }
  }
  if (merged.engine !== 'claude' && merged.engine !== 'codex') merged.engine = 'claude';
  db.prepare("INSERT INTO settings(key,value) VALUES('app',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    JSON.stringify(merged),
  );
  return merged;
}
