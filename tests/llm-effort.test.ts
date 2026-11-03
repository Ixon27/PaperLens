import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import type { EngineModels, ModelChoice, ModelSpec } from '../src/shared/models';

vi.mock('../src/server/config', async () => {
  // Vitest hoists factories before static imports; their dependencies must load inside the factory.
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { BIN: { claude: '/fixture/claude', codex: '/fixture/codex' }, PATHS: { tmp: mkdtempSync(join(tmpdir(), 'paperlens-effort-')) } };
});
vi.mock('../src/server/settings', () => ({ getSettings: vi.fn(), rememberLastEngine: vi.fn() }));
vi.mock('../src/server/provider-connect', () => ({ cancelProviderOperations: vi.fn() }));
vi.mock('../src/server/llm/models', () => ({ getEngineModels: vi.fn(), shutdownModelCatalog: vi.fn() }));
vi.mock('../src/server/llm/command', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { writeFileSync } = await import('node:fs');
  return {
    stopCli: vi.fn(),
    spawnCli: vi.fn((bin: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, kill: vi.fn(() => true) });
      child.stdin.once('finish', () => queueMicrotask(() => {
        if (bin.endsWith('codex')) writeFileSync(args[args.indexOf('-o') + 1], 'fixture answer');
        else child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'fixture answer' }) + '\n');
        child.exitCode = 0;
        child.emit('close', 0);
        child.stdout.end();
        child.stderr.end();
      }));
      return child;
    }),
  };
});

import { PATHS } from '../src/server/config';
import { getEngineModels } from '../src/server/llm/models';
import { spawnCli } from '../src/server/llm/command';
import { prepareModel, runLlm } from '../src/server/llm/index';

const choice: ModelChoice = { value: 'supported', label: 'Supported', description: '', efforts: ['low', 'high', 'max'], defaultEffort: 'high', isDefault: true };
beforeEach(() => {
  vi.mocked(getEngineModels).mockReset().mockResolvedValue({ models: [choice], error: null });
  vi.mocked(spawnCli).mockClear();
});
afterAll(() => rmSync(PATHS.tmp, { recursive: true, force: true }));

it.each(['claude', 'codex'] as const)('passes supported %s effort to real adapter arguments and reports only sent settings', async engine => {
  const result = await runLlm({ system: 'fixture', prompt: 'fixture', profile: 'quick', model: { engine, model: 'supported', effort: 'max' } });
  const args = vi.mocked(spawnCli).mock.calls[0][1];
  expect(args).toContain(engine === 'claude' ? '--effort' : 'model_reasoning_effort="max"');
  if (engine === 'claude') expect(args[args.indexOf('--effort') + 1]).toBe('max');
  expect(result.by).toEqual({ engine, model: 'supported', effort: 'max' });
});

it.each(['claude', 'codex'] as const)('uses %s advertised default instead of unsupported stale preference', async engine => {
  const result = await runLlm({ system: 'fixture', prompt: 'fixture', profile: 'heavy', model: { engine, model: 'supported', effort: 'ultra' } });
  const args = vi.mocked(spawnCli).mock.calls[0][1];
  expect(result.by.effort).toBe('high');
  if (engine === 'claude') expect(args[args.indexOf('--effort') + 1]).toBe('high');
  else expect(args).toContain('model_reasoning_effort="high"');
});

it.each(['claude', 'codex'] as const)('omits %s effort flags for unsupported models or unknown metadata', async engine => {
  for (const catalog of [
    { models: [{ ...choice, efforts: [], defaultEffort: undefined }], error: null },
    { models: [{ ...choice, efforts: ['low'], defaultEffort: undefined }], error: null },
    { models: [], error: 'metadata unavailable' },
  ]) {
    vi.mocked(getEngineModels).mockResolvedValue(catalog);
    const result = await runLlm({ system: 'fixture', prompt: 'fixture', profile: 'heavy', model: { engine, model: 'supported', effort: 'high' } });
    const args = vi.mocked(spawnCli).mock.lastCall![1];
    expect(args).not.toContain('--effort');
    expect(args.some(arg => arg.startsWith('model_reasoning_effort='))).toBe(false);
    expect(result.by.effort).toBe('');
  }
});

it.each(['quick', 'heavy'] as const)('migrates an empty legacy thread effort using its %s preference', async profile => {
  const result = await prepareModel(profile, { engine: 'claude', model: 'supported', effort: '' });
  expect(result.effort).toBe(profile === 'quick' ? 'low' : 'high');
  expect(spawnCli).not.toHaveBeenCalled();
});

it('does not replace a saved model absent from a successful CLI catalog', async () => {
  await expect(runLlm({ system: 'fixture', prompt: 'fixture', profile: 'quick', model: { engine: 'claude', model: 'removed-model', effort: 'low' } })).rejects.toThrow('removed-model');
  expect(spawnCli).not.toHaveBeenCalled();
});

it('keeps Codex default model unknown rather than inventing support from the first listed model', async () => {
  vi.mocked(getEngineModels).mockResolvedValue({ models: [{ ...choice, isDefault: false }], error: null });
  const result = await runLlm({ system: 'fixture', prompt: 'fixture', profile: 'quick', model: { engine: 'codex', model: '', effort: 'low' } });
  expect(result.by).toEqual({ engine: 'codex', model: '', effort: '' });
  expect(vi.mocked(spawnCli).mock.lastCall![1]).not.toContain('-m');
});

it('captures model and effort before metadata awaits so active requests do not follow picker changes', async () => {
  const deferred = Promise.withResolvers<EngineModels>();
  vi.mocked(getEngineModels).mockReturnValueOnce(deferred.promise);
  const requested: ModelSpec = { engine: 'claude', model: 'supported', effort: 'low' };
  const running = runLlm({ system: 'fixture', prompt: 'fixture', profile: 'quick', model: requested });
  requested.model = 'new-picker-model';
  requested.effort = 'max';
  deferred.resolve({ models: [choice], error: null });
  expect((await running).by).toEqual({ engine: 'claude', model: 'supported', effort: 'low' });
});
