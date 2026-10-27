import { getPaper, putArtifact } from '../db';
import { startJob } from '../jobs';
import { resolveModel, runLlm } from '../llm/index';
import { paperSystem } from '../pdf/context';
import { fill, loadPrompt } from '../prompts';
import { getSettings } from '../settings';
import { RETRY_SUFFIX } from './analysis';

export const ADDONS = ['gap', 'critique', 'questions'] as const;
export type AddonId = (typeof ADDONS)[number];
export const isAddon = (value: unknown): value is AddonId => typeof value === 'string' && (ADDONS as readonly string[]).includes(value);
export const addonKind = (id: AddonId) => `addon-${id}`;

const TEXT_THROTTLE_MS = 200;

export function startAddons(paperId: string, ids: AddonId[]): string {
  return startJob(paperId, 'addons', async (ctx) => {
    const paper = getPaper(paperId);
    if (!paper) throw new Error('논문을 찾을 수 없습니다');
    const settings = getSettings();
    const by = resolveModel('heavy', settings);
    const P = loadPrompt('analysis');
    const head = fill(P.COMMON, { title: paper.title, context: settings.readerContext });
    const system = paperSystem(paper);
    const selected = ADDONS.filter((id) => ids.includes(id));
    const parts: Partial<Record<AddonId, string>> = {};
    let done = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const showText = () => {
      timer = undefined;
      ctx.setText(ADDONS.map((id) => parts[id]).filter(Boolean).join('\n\n'));
    };
    const scheduleText = () => {
      timer ??= setTimeout(showText, TEXT_THROTTLE_MS);
    };

    const runCall = async (id: AddonId) => {
      const prompt = head + '\n\n---\n\n' + P['ADDON:' + id];
      const call = async (p: string) => {
        parts[id] = '';
        scheduleText();
        const onDelta = (text: string) => {
          parts[id] = (parts[id] ?? '') + text;
          scheduleText();
        };
        return (await runLlm({ system, prompt: p, profile: 'heavy', model: by, signal: ctx.signal, onDelta })).text;
      };
      let out = await call(prompt);
      if (!out.includes('####')) out = await call(prompt + RETRY_SUFFIX);
      if (ctx.signal.aborted) throw new Error('취소됨');
      if (!out.includes('####')) throw new Error('추가 분석에 소제목이 없습니다');
      parts[id] = out.trim();
      putArtifact(paperId, addonKind(id), out.trim(), {}, by);
      done += 1;
      scheduleText();
      ctx.progress(done / selected.length, `추가 분석 ${done}/${selected.length} 완료`);
    };

    ctx.progress(0, '추가 분석을 동시에 작성 중…');
    const settled = await Promise.allSettled(selected.map(runCall));
    clearTimeout(timer);
    showText();
    if (ctx.signal.aborted) throw new Error('취소됨');
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  });
}
