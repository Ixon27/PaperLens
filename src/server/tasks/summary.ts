import { getPaper, putArtifact } from '../db';
import { startJob } from '../jobs';
import { resolveModel, runLlm } from '../llm';
import { paperSystem } from '../pdf/context';
import { fill, loadPrompt } from '../prompts';
import { getSettings } from '../settings';

const RETRY_SUFFIX = '\n\n(다시. 설명하지 말고 위 #### 소제목을 글자 그대로 쓴 본문만 출력하라.)';
/** The quick model still reads the whole paper; 2 minutes is too short for some CLIs. */
const TIMEOUT_MS = 300_000;

/** Start (or reuse) the quick summary shown above the deep analysis; returns the job id. */
export function startSummary(paperId: string): string {
  return startJob(paperId, 'summary', async (ctx) => {
    const paper = getPaper(paperId);
    if (!paper) throw new Error('논문을 찾을 수 없습니다');
    const settings = getSettings();
    const by = resolveModel('quick', settings);
    const system = paperSystem(paper, { includeRefs: false });
    const prompt = fill(loadPrompt('summary').PROMPT, { title: paper.title, context: settings.readerContext });
    const call = async (p: string) =>
      (await runLlm({ system, prompt: p, profile: 'quick', model: by, timeoutMs: TIMEOUT_MS, signal: ctx.signal, onDelta: (t) => ctx.delta(t) })).text;

    ctx.progress(0.05, '요약 작성 중…');
    let text = await call(prompt);
    if (!text.includes('####')) {
      ctx.setText('');
      text = await call(prompt + RETRY_SUFFIX);
    }
    ctx.setText(text);
    putArtifact(paperId, 'summary', text.trim(), {}, by);
  });
}
