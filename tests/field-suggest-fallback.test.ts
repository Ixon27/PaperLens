import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Config from '../src/server/config';

vi.mock('../src/server/config', async (importOriginal) => {
  const original = await importOriginal<typeof Config>();
  return { ...original, PATHS: { ...original.PATHS, db: ':memory:' } };
});
vi.mock('../src/server/llm/index', () => ({ runLlm: vi.fn(), enginesAvailable: vi.fn() }));

import { db, getPaper } from '../src/server/db';
import { classifyEngineFailure, engineOrder } from '../src/server/llm/fallback';
import { enginesAvailable, runLlm } from '../src/server/llm/index';
import { rememberLastEngine } from '../src/server/settings';
import { suggestField } from '../src/server/tasks/suggest-field';

const answer = (field: string) => ({ text: JSON.stringify({ field }), by: { engine: 'claude' as const, model: 'sonnet', effort: '' } });
const enginesTried = () => vi.mocked(runLlm).mock.calls.map(([req]) => req.model?.engine);
const paper = () => getPaper('paper')!;

beforeEach(() => {
  db.prepare('DELETE FROM papers').run();
  db.prepare('INSERT INTO papers(id,title,abstract,created_at,updated_at) VALUES(?,?,?,?,?)').run('paper', 'Gravitational waves', 'We observe a binary merger.', '2025-01-01', '2025-01-01');
  vi.mocked(runLlm).mockReset();
  vi.mocked(enginesAvailable).mockReset().mockReturnValue({ claude: true, codex: true });
});

describe('engine failures that move field detection to the other AI', () => {
  it('treats usage limits and sign-in problems as unavailable, and nothing else', () => {
    expect(classifyEngineFailure("You've hit your session limit · resets 3pm (Asia/Seoul)")).toBe('usage');
    expect(classifyEngineFailure("codex 실패 (exit 1): You've hit your usage limit. Upgrade to Plus to continue using Codex")).toBe('usage');
    expect(classifyEngineFailure('codex 실패 (exit 1): unexpected status 429 Too Many Requests')).toBe('usage');
    expect(classifyEngineFailure('Credit balance is too low')).toBe('usage');
    expect(classifyEngineFailure('Not logged in · Please run /login')).toBe('auth');
    expect(classifyEngineFailure('시간 초과')).toBeNull();
    expect(classifyEngineFailure('codex 응답 없음: ')).toBeNull();
    expect(classifyEngineFailure('취소됨')).toBeNull();
  });

  it('starts with the last engine that answered, else the selected one', () => {
    expect(engineOrder('codex', 'claude')).toEqual(['codex', 'claude']);
    expect(engineOrder(null, 'claude')).toEqual(['claude', 'codex']);
    expect(engineOrder(null, 'codex')).toEqual(['codex', 'claude']);
  });
});

describe('suggestField', () => {
  it('falls back to the other engine when the last one is out of usage', async () => {
    rememberLastEngine('codex');
    vi.mocked(runLlm).mockRejectedValueOnce(new Error("codex 실패 (exit 1): You've hit your usage limit.")).mockResolvedValueOnce(answer('physics'));
    await expect(suggestField(paper())).resolves.toEqual({ suggested: 'physics', engine: 'claude', skipped: [{ engine: 'codex', reason: 'usage' }] });
    expect(enginesTried()).toEqual(['codex', 'claude']);
    expect(paper().field_suggested).toBe('physics');
  });

  it('uses only the last engine when it answers', async () => {
    rememberLastEngine('claude');
    vi.mocked(runLlm).mockResolvedValueOnce(answer('astro'));
    await expect(suggestField(paper())).resolves.toEqual({ suggested: 'astro', engine: 'claude', skipped: [] });
    expect(enginesTried()).toEqual(['claude']);
  });

  it('reports both engines and stores nothing when neither can answer', async () => {
    rememberLastEngine('claude');
    vi.mocked(runLlm)
      .mockRejectedValueOnce(new Error("You've hit your weekly limit"))
      .mockRejectedValueOnce(new Error('codex 실패 (exit 1): Not logged in'));
    await expect(suggestField(paper())).rejects.toThrow('Claude: 사용량 한도, Codex: 로그인 필요');
    expect(paper().field_suggested).toBeNull();
  });

  it('does not spend the other engine on ordinary failures', async () => {
    rememberLastEngine('claude');
    vi.mocked(runLlm).mockRejectedValueOnce(new Error('시간 초과'));
    await expect(suggestField(paper())).rejects.toThrow('시간 초과');
    expect(enginesTried()).toEqual(['claude']);
  });

  it('skips an engine that is not installed', async () => {
    rememberLastEngine('codex');
    vi.mocked(enginesAvailable).mockReturnValue({ claude: true, codex: false });
    vi.mocked(runLlm).mockResolvedValueOnce(answer('cs'));
    await expect(suggestField(paper())).resolves.toEqual({ suggested: 'cs', engine: 'claude', skipped: [{ engine: 'codex', reason: 'missing' }] });
    expect(enginesTried()).toEqual(['claude']);
  });
});
