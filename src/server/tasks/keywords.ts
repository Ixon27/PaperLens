import { getPaper } from '../db';
import { startJob } from '../jobs';
import { parseJsonLoose } from '../json';
import { resolveModel, runLlm } from '../llm';
import { paperSystem } from '../pdf/context';
import { loadPrompt } from '../prompts';
import { normalizeKeywords, replaceAutoKeywords, type KeywordEntry } from '../terms';

const JSON_ONLY = '\n\n(설명 없이 JSON 배열 하나만 출력하라.)';
/** The quick model reads the whole paper, as the summary does. */
const TIMEOUT_MS = 300_000;

/** Start (or reuse) the job that picks the paper's core terms for the 키워드 사전; returns the job id. */
export function startKeywords(paperId: string): string {
  return startJob(paperId, 'keywords', async (ctx) => {
    const paper = getPaper(paperId);
    if (!paper) throw new Error('논문을 찾을 수 없습니다');
    const P = loadPrompt('terms');
    const by = resolveModel('quick');
    const system = paperSystem(paper, { includeRefs: false });

    ctx.progress(0.05, '핵심 용어 고르는 중…');
    let entries: KeywordEntry[] = [];
    for (const prompt of [P.KEYWORDS, P.KEYWORDS + JSON_ONLY]) {
      const { text } = await runLlm({ system, prompt, profile: 'quick', model: by, timeoutMs: TIMEOUT_MS, signal: ctx.signal });
      try {
        entries = normalizeKeywords(parseJsonLoose<unknown>(text));
      } catch {
        // retry once with the JSON-only suffix
      }
      if (entries.length) break;
    }
    if (!entries.length) throw new Error('핵심 용어를 만들지 못했습니다');
    replaceAutoKeywords(paperId, entries, by);
  });
}
