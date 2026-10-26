import { getPaper, putArtifact } from '../db';
import { startJob } from '../jobs';
import { runLlm } from '../llm/index';
import { paperSystem } from '../pdf/context';
import { fill, loadPrompt } from '../prompts';
import { getSettings } from '../settings';
import type { ResearchType } from './classify';

const RETRY_SUFFIX = '\n\n(다시. 설명하지 말고 위 #### 소제목을 글자 그대로 쓴 본문만 출력하라.)';

export interface AnalysisMeta {
  types: ResearchType[];
  callsDone: number;
  engine: string;
}

/** Start (or reuse) the 3-call structured analysis job; returns the job id. */
export function startAnalysis(paperId: string, types: ResearchType[]): string {
  return startJob(paperId, 'analysis', async (ctx) => {
    const paper = getPaper(paperId);
    if (!paper) throw new Error('논문을 찾을 수 없습니다');
    const settings = getSettings();
    const engine = settings.engine;

    const P = loadPrompt('analysis');
    const methods = types.map((t) => P['METHODS:' + t]).join('\n\n');
    const results = types.length === 1 && types[0] === 'review' ? P['RESULTS:review'] : P['RESULTS:default'];
    const head = fill(P.COMMON, { title: paper.title, context: settings.readerContext });
    const system = paperSystem(paper);

    const done: string[] = [];
    for (let j = 1; j <= 3; j++) {
      ctx.progress((j - 1) / 3, `분석 ${j}/3 작성 중…`);
      const prompt = head + '\n\n---\n\n' + fill(P['CALL ' + j], { methods, results });
      const prefix = done.join('\n\n') + (j > 1 ? '\n\n' : '');
      if (j > 1) ctx.delta('\n\n', { call: j });
      const call = (p: string) => runLlm({ system, prompt: p, profile: 'heavy', signal: ctx.signal, onDelta: (t) => ctx.delta(t, { call: j }) }, engine);

      let out = await call(prompt);
      if (!out.includes('####')) {
        ctx.setText(prefix);
        out = await call(prompt + RETRY_SUFFIX);
      }
      done.push(out.trim());
      // Codex has no deltas: make the accumulated text authoritative after each call.
      ctx.setText(done.join('\n\n'));
      const meta: AnalysisMeta = { types, callsDone: j, engine };
      putArtifact(paperId, 'analysis', done.join('\n\n'), meta, engine);
      ctx.progress(j / 3, j < 3 ? `분석 ${j}/3 완료` : '분석 완료');
    }
  });
}
