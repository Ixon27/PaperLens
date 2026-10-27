import { afterEach, beforeEach, expect, it } from 'vitest';
import { db } from '../src/server/db';
import { HttpError } from '../src/server/http-error';
import { getSettings, saveSettings } from '../src/server/settings';

let previous: { value: string } | undefined;
beforeEach(() => {
  previous = db.prepare("SELECT value FROM settings WHERE key='app'").get() as { value: string } | undefined;
});
afterEach(() => {
  if (previous) db.prepare("INSERT INTO settings(key,value) VALUES('app',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(previous.value);
  else db.prepare("DELETE FROM settings WHERE key='app'").run();
});

it('rejects an effort that could escape the Codex config argument', () => {
  let error: unknown;
  try {
    saveSettings({ codex: { quickEffort: 'high" x' } });
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).status).toBe(400);
  expect((error as HttpError).message).toBe('AI 작업 수준 값이 올바르지 않습니다');
});

it('persists a per-profile Claude effort', () => {
  // The scratch vault directory does not exist; disconnect it so only the effort is under test.
  saveSettings({ claude: { heavyEffort: 'max' }, vaultPath: null });
  expect(getSettings().claude.heavyEffort).toBe('max');
});

it('carries a stored single Codex model into both profiles', () => {
  db.prepare("INSERT INTO settings(key,value) VALUES('app',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    '{"codex":{"model":"gpt-6-luna","quickEffort":"low","heavyEffort":"high"}}',
  );
  const { codex } = getSettings();
  expect(codex.quickModel).toBe('gpt-6-luna');
  expect(codex.heavyModel).toBe('gpt-6-luna');
});
