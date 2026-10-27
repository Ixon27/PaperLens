import { expect, it } from 'vitest';
import { appendModels } from '../src/server/llm/models';
import type { ModelChoice } from '../src/shared/models';

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
