import { afterAll, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import type * as Config from '../src/server/config';

vi.mock('../src/server/config', async (importOriginal) => {
  const original = await importOriginal<typeof Config>();
  // Vitest hoists this factory ahead of ordinary static imports.
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tmp = mkdtempSync(join(tmpdir(), 'paperlens-llm-test-'));
  return { ...original, PATHS: { ...original.PATHS, db: ':memory:', tmp }, BIN: { claude: '/fake/claude', codex: '/fake/codex' } };
});
vi.mock('../src/server/llm/claude', () => ({ runClaude: vi.fn(async () => 'ok') }));
vi.mock('../src/server/llm/codex', () => ({
  runCodex: vi.fn(async () => {
    throw new Error("codex 실패 (exit 1): You've hit your usage limit.");
  }),
}));

import { PATHS } from '../src/server/config';
import { runLlm } from '../src/server/llm/index';
import { getLastEngine } from '../src/server/settings';

afterAll(() => rmSync(PATHS.tmp, { recursive: true, force: true }));

it('remembers the engine of the latest successful answer, not of a failed call', async () => {
  expect(getLastEngine()).toBeNull();
  await runLlm({ system: 's', prompt: 'p', profile: 'quick', model: { engine: 'claude', model: 'sonnet', effort: '' } });
  expect(getLastEngine()).toBe('claude');
  await expect(runLlm({ system: 's', prompt: 'p', profile: 'quick', model: { engine: 'codex', model: '', effort: '' } })).rejects.toThrow('usage limit');
  expect(getLastEngine()).toBe('claude');
});
