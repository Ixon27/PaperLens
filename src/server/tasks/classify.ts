import { db, getBlocks, type PaperRow } from '../db';
import { parseJsonLoose } from '../json';
import { runLlm } from '../llm/index';
import { abstractOrPageOne } from '../pdf/context';
import { fill, loadPrompt } from '../prompts';

export const RESEARCH_TYPES = ['wetlab', 'omics', 'review', 'clinical'] as const;
export type ResearchType = (typeof RESEARCH_TYPES)[number];

export const isResearchType = (t: unknown): t is ResearchType => typeof t === 'string' && (RESEARCH_TYPES as readonly string[]).includes(t);

export interface ClassifyResult {
  types: ResearchType[];
  reason: string;
}

const METHODS_HEADING = /^\s*(\d+\.?\s*)?(materials and methods|methods|methodology|experimental( procedures| section)?)\s*$/i;

/** Methods body after the first Methods heading (4,000 chars), else the first 6,000 chars of the paper. */
export function methodsExcerpt(paperId: string): string {
  const blocks = getBlocks(paperId);
  const at = blocks.findIndex((b) => METHODS_HEADING.test(b.text));
  if (at >= 0) {
    return blocks
      .slice(at + 1)
      .map((b) => b.text)
      .join('\n')
      .slice(0, 4000);
  }
  return blocks
    .map((b) => b.text)
    .join('\n')
    .slice(0, 6000);
}

const FALLBACK: ClassifyResult = { types: ['wetlab'], reason: '분류 실패 — 직접 고르세요' };

export async function classifyPaper(paper: PaperRow): Promise<ClassifyResult> {
  const P = loadPrompt('classify');
  const prompt = fill(P.PROMPT, { title: paper.title, abstract: abstractOrPageOne(paper), methods_excerpt: methodsExcerpt(paper.id) });
  const out = await runLlm({ system: '너는 연구 논문의 연구 유형을 분류한다. JSON 하나로만 답한다.', prompt, profile: 'quick' });
  let result: ClassifyResult = FALLBACK;
  try {
    const parsed = parseJsonLoose<{ types?: unknown; reason?: unknown }>(out);
    const types = Array.isArray(parsed.types) ? [...new Set(parsed.types.filter(isResearchType))].slice(0, 2) : [];
    if (types.length) result = { types, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
  } catch {
    // parse failure → fallback
  }
  db.prepare('UPDATE papers SET research_types=? WHERE id=?').run(JSON.stringify(result.types), paper.id);
  return result;
}
