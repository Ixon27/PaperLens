import { expect, it } from 'vitest';
import { appendModels, parseCliVersion } from '../src/server/llm/models';
import type { ModelChoice } from '../src/shared/models';
import { catalogModel, preferredEffort, resolveEffort } from '../src/shared/models';

it('keeps Claude effort levels only for models that support effort', () => {
  const models: ModelChoice[] = [];
  appendModels(models, new Set(), [
    { value: 'sonnet', displayName: 'Sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
    { value: 'old', displayName: 'Old' },
  ], 'claude');
  expect(models.map((m) => m.efforts)).toEqual([['low', 'high'], []]);
});

it('reads Codex reasoning efforts, default effort and default model, skipping hidden models', () => {
  const models: ModelChoice[] = [];
  appendModels(models, new Set(), [
    {
      model: 'gpt-x',
      displayName: 'X',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'xhigh' }],
      defaultReasoningEffort: 'low',
      isDefault: true,
    },
    { model: 'h', hidden: true },
  ], 'codex');
  expect(models).toHaveLength(1);
  expect(models[0]).toMatchObject({ value: 'gpt-x', efforts: ['low', 'xhigh'], defaultEffort: 'low', isDefault: true });
});

it('uses only advertised concrete efforts and a supported CLI default', () => {
  const models: ModelChoice[] = [];
  appendModels(models, new Set(), [
    { value: 'new', supportsEffort: true, supportedEffortLevels: ['auto', 'low', 'high', 'high'], defaultEffort: 'high' },
    { value: 'unknown-default', supportsEffort: true, supportedEffortLevels: ['low'], defaultEffort: 'max' },
    { value: 'unsupported', supportsEffort: false, supportedEffortLevels: ['high'], defaultEffort: 'high' },
  ], 'claude');
  expect(models.map(model => ({ efforts: model.efforts, defaultEffort: model.defaultEffort }))).toEqual([
    { efforts: ['low', 'high'], defaultEffort: 'high' },
    { efforts: ['low'], defaultEffort: undefined },
    { efforts: [], defaultEffort: undefined },
  ]);
  expect(resolveEffort('max', models[0])).toBe('high');
  expect(resolveEffort('high', models[1])).toBe('');
  expect(resolveEffort('high', models[2])).toBe('');
});

it('preserves explicitly supported settings and thread effort rather than normalizing their strength', () => {
  const model: ModelChoice = { value: 'any', label: 'Any', description: '', efforts: ['low', 'high', 'max'], defaultEffort: 'high' };
  expect(resolveEffort('max', model)).toBe('max');
  expect(resolveEffort('low', model)).toBe('low');
  expect(resolveEffort('auto', model)).toBe('high');
  expect(resolveEffort('high', undefined)).toBe('');
});

it('uses low/high for empty legacy profile and thread preferences', () => {
  expect(preferredEffort('', 'quick')).toBe('low');
  expect(preferredEffort('', 'heavy')).toBe('high');
  expect(preferredEffort('auto', 'quick')).toBe('low');
  expect(preferredEffort('max', 'quick')).toBe('max');
});

it('resolves Codex CLI-default support only when the CLI identifies its default model', () => {
  const model: ModelChoice = { value: 'dynamic-model', label: 'Dynamic', description: '', efforts: ['low'], defaultEffort: 'low', isDefault: true };
  expect(catalogModel('codex', [model], '')).toBe(model);
  expect(resolveEffort('high', catalogModel('codex', [model], ''))).toBe('low');
  expect(resolveEffort('high', catalogModel('codex', [{ ...model, isDefault: false }], ''))).toBe('');
  expect(catalogModel('claude', [model], 'stale-saved-model')).toBeUndefined();
});

it('exposes version tokens without account metadata or raw CLI diagnostics', () => {
  expect(parseCliVersion('codex-cli 1.2.3\\nprivate@example.com token=secret')).toBe('1.2.3');
  expect(parseCliVersion('2.1.5 (Claude Code)')).toBe('2.1.5');
  expect(parseCliVersion('private@example.com token=secret')).toBeNull();
});
