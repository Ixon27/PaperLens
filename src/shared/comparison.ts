import type { MadeBy } from './models';

export const COMPARISON_DIMENSIONS = ['question', 'method', 'data', 'results', 'limitations'] as const;
export type ComparisonDimension = (typeof COMPARISON_DIMENSIONS)[number];
export const COMPARISON_LABELS: Record<ComparisonDimension, string> = { question: '연구 질문', method: '방법', data: '데이터', results: '결과', limitations: '한계' };
export interface ComparisonBlock { idx: number; page: number; text: string; isRef: boolean }
export interface ComparisonPaper { id: string; title: string; sampledBlocks: number; totalBlocks: number }
export interface ComparisonSource { paperId: string; page: number; quote: string; blockIdx: number; start: number; end: number }
export interface ComparisonClaim { text: string; unavailable: boolean; sources: ComparisonSource[] }
export interface ComparisonSection { dimension: ComparisonDimension; papers: { paperId: string; claim: ComparisonClaim }[]; synthesis: ComparisonClaim }
export interface ComparisonResult { version: 1; id: string; createdAt: string; by: MadeBy; papers: ComparisonPaper[]; sections: ComparisonSection[] }
export interface ComparisonExcerpt { sourceId: string; paperId: string; page: number; quote: string; numericTokens: string[] }
export interface ComparisonInputPaper { id: string; blocks: ComparisonBlock[]; sources?: ComparisonExcerpt[] }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 4000): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error('비교 텍스트 형식이 올바르지 않습니다');
  return v.trim();
};
export function validateComparisonIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 4) throw new Error('논문은 2~4개 선택해야 합니다');
  const ids = raw.map((id) => text(id, 200));
  if (new Set(ids).size !== ids.length) throw new Error('중복된 논문은 비교할 수 없습니다');
  return ids;
}

/** The complete literal quote must occur on the stated paper/page. No fuzzy or nearby-page fallback. */
export function locateComparisonSource(raw: unknown, papers: ComparisonInputPaper[]): ComparisonSource {
  if (object(raw) && typeof raw.sourceId === 'string') {
    const sourceId = raw.sourceId;
    const excerpt = papers.flatMap((p) => p.sources ?? []).find((s) => s.sourceId === sourceId);
    if (!excerpt) throw new Error('선택한 PDF 발췌에 없는 근거 ID입니다');
    // IDs only select server-owned text. The normal exact paper/page quote matcher still verifies it.
    raw = { paperId: excerpt.paperId, page: excerpt.page, quote: excerpt.quote };
  }
  if (!object(raw) || typeof raw.paperId !== 'string' || !Number.isInteger(raw.page) || (raw.page as number) < 1) throw new Error('비교 근거 위치가 올바르지 않습니다');
  const paper = papers.find((p) => p.id === raw.paperId);
  const quote = text(raw.quote, 2000);
  if (!paper || quote.replace(/\s/g, '').length < 12) throw new Error('선택한 논문의 충분한 원문 근거가 필요합니다');
  const pattern = new RegExp(quote.split(/\s+/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'u');
  for (const b of paper.blocks) {
    if (b.isRef || b.page !== raw.page) continue;
    const match = pattern.exec(b.text);
    if (match) return { paperId: paper.id, page: b.page, quote: match[0], blockIdx: b.idx, start: match.index, end: match.index + match[0].length };
  }
  throw new Error(`${raw.paperId} p.${raw.page} 원문에서 인용문을 찾을 수 없습니다`);
}
export const comparisonNumericTokens = (s: string): string[] => s.match(/[-+−]?\d+(?:[.,]\d+)*(?:%|‰)?/g) ?? [];
function claim(raw: unknown, papers: ComparisonInputPaper[], onlyPaper?: string): ComparisonClaim {
  if (!object(raw) || typeof raw.unavailable !== 'boolean' || !Array.isArray(raw.sources) || raw.sources.length > 8) throw new Error('비교 항목 형식이 올바르지 않습니다');
  const value = text(raw.text);
  const sources = raw.sources.map((s) => locateComparisonSource(s, papers));
  if (onlyPaper && sources.some((s) => s.paperId !== onlyPaper)) throw new Error('다른 논문의 근거로 항목을 뒷받침할 수 없습니다');
  if (raw.unavailable ? sources.length !== 0 : sources.length === 0) throw new Error('확인한 항목에는 원문 근거가 필요합니다');
  if (raw.unavailable && comparisonNumericTokens(value).length) throw new Error('확인할 수 없는 항목에 수치를 넣을 수 없습니다');
  const evidenceNumbers = new Set(sources.flatMap((s) => comparisonNumericTokens(s.quote)));
  const unsupported = comparisonNumericTokens(value).filter((n) => !evidenceNumbers.has(n));
  if (unsupported.length) throw new Error(`원문 인용에 없는 수치를 비교 결과에 넣을 수 없습니다 (${[...new Set(unsupported)].join(', ')})`);
  return { text: value, unavailable: raw.unavailable, sources };
}
export function validateComparisonGeneration(raw: unknown, papers: ComparisonInputPaper[]): ComparisonSection[] {
  validateComparisonIds(papers.map((p) => p.id));
  if (!object(raw) || !Array.isArray(raw.sections) || raw.sections.length !== COMPARISON_DIMENSIONS.length) throw new Error('다섯 가지 비교 항목이 필요합니다');
  return COMPARISON_DIMENSIONS.map((dimension) => {
    const section = (raw.sections as unknown[]).find((s) => object(s) && s.dimension === dimension);
    if (!object(section) || !Array.isArray(section.papers) || section.papers.length !== papers.length) throw new Error('모든 논문의 비교 항목이 필요합니다');
    const seen = new Set<string>();
    const cells = section.papers.map((cell) => {
      if (!object(cell) || typeof cell.paperId !== 'string' || seen.has(cell.paperId) || !papers.some((p) => p.id === cell.paperId)) throw new Error('비교 논문이 누락되었거나 중복되었습니다');
      seen.add(cell.paperId);
      return { paperId: cell.paperId, claim: claim(cell.claim, papers, cell.paperId) };
    });
    const synthesis = claim(section.synthesis, papers);
    if (!synthesis.unavailable && new Set(synthesis.sources.map((s) => s.paperId)).size < 2) throw new Error('논문 간 비교에는 두 논문 이상의 근거가 필요합니다');
    return { dimension, papers: cells, synthesis };
  });
}

/** Bounded PDF-only source selection: coverage samples plus method/results/limitation passages. */
export function selectComparisonBlocks(blocks: ComparisonBlock[], maxChars = 24000): ComparisonBlock[] {
  const eligible = blocks.filter((b) => !b.isRef && b.text.replace(/\s/g, '').length >= 12);
  if (eligible.reduce((n, b) => n + b.text.length, 0) <= maxChars) return eligible;
  const chosen = new Set<number>();
  const order: number[] = [];
  const add = (i: number) => { if (!chosen.has(i)) { chosen.add(i); order.push(i); } };
  // First/last sections and evenly distributed body passages prevent heading-only retrieval.
  for (let i = 0; i < Math.min(12, eligible.length); i++) add(Math.round(i * (eligible.length - 1) / Math.max(1, Math.min(12, eligible.length) - 1)));
  const ranked = eligible.map((b, i) => ({ i, score: (b.text.match(/\b(method|experiment|dataset|participant|result|limitation|conclusion|objective|hypothesis|accuracy|sample)\w*/gi) ?? []).length })).sort((a, b) => b.score - a.score || a.i - b.i);
  for (const { i } of ranked) add(i);
  let remaining = maxChars;
  const selected: ComparisonBlock[] = [];
  for (const i of order) {
    if (remaining < 100) break;
    const b = eligible[i];
    const excerpt = b.text.slice(0, Math.min(1600, remaining));
    selected.push({ ...b, text: excerpt });
    remaining -= excerpt.length;
  }
  return selected.sort((a, b) => a.idx - b.idx);
}

/** Stable excerpt references remove AI quote retyping; saved citations still contain literal PDF text. */
export function buildComparisonSources(papers: ComparisonInputPaper[]): ComparisonExcerpt[] {
  const sources: ComparisonExcerpt[] = [];
  for (const [paperIndex, paper] of papers.entries()) {
    for (const block of paper.blocks) {
      if (block.isRef) continue;
      for (let offset = 0; offset < block.text.length; offset += 1600) {
        const quote = block.text.slice(offset, offset + 1600).trim();
        if (quote.replace(/\s/g, '').length < 12) continue;
        sources.push({ sourceId: `paper${paperIndex + 1}.block${block.idx}.part${offset}`, paperId: paper.id, page: block.page, quote, numericTokens: comparisonNumericTokens(quote) });
      }
    }
  }
  return sources;
}
export function comparisonSourceHref(source: Pick<ComparisonSource, 'paperId' | 'page' | 'quote'>): string {
  return `/paper/${encodeURIComponent(source.paperId)}#p-${source.page}~${encodeURIComponent(source.quote).replace(/[()]/g, (c) => c === '(' ? '%28' : '%29')}`;
}
const mdText = (s: string) => s.replace(/[\\`*_{}\[\]<>#|]/g, '\\$&');
export function comparisonMarkdown(result: ComparisonResult): string {
  const title = (id: string) => result.papers.find((p) => p.id === id)?.title ?? id;
  const renderClaim = (c: ComparisonClaim) => `${c.unavailable ? '**제공된 원문에서 확인 불가**: ' : ''}${mdText(c.text)}\n${c.sources.map((s) => `- [${mdText(title(s.paperId))} · p.${s.page}](${comparisonSourceHref(s)}) — “${mdText(s.quote.replace(/\s+/g, ' '))}”`).join('\n')}`;
  return `# 논문 비교\n\n생성: ${result.createdAt}\n모델: ${result.by.engine} / ${result.by.model || 'CLI 기본값'} / 요청 effort: ${result.by.effort || '미지정'} (실제 내부 effort 아님)\n\n선택한 PDF 원문만 사용했습니다. 발췌에서 확인되지 않은 내용은 논문 전체에 없다는 뜻이 아닙니다.\n\n${result.papers.map((p) => `- ${mdText(p.title)} (${p.sampledBlocks}/${p.totalBlocks} 본문 블록 제공)`).join('\n')}\n\n${result.sections.map((s) => `## ${COMPARISON_LABELS[s.dimension]}\n\n${s.papers.map((p) => `### ${mdText(title(p.paperId))}\n\n${renderClaim(p.claim)}`).join('\n\n')}\n\n### 비교\n\n${renderClaim(s.synthesis)}`).join('\n\n')}\n`;
}

/** Parse sync arrivals without needing all referenced PDFs to be present on this device. */
export function parseComparisonResult(raw: unknown): ComparisonResult {
  if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.papers) || !object(raw.by) || !['claude', 'codex'].includes(String(raw.by.engine))) throw new Error('저장된 비교 형식이 올바르지 않습니다');
  const papers = raw.papers.map((p) => {
    if (!object(p) || !Number.isInteger(p.sampledBlocks) || !Number.isInteger(p.totalBlocks) || (p.sampledBlocks as number) < 1 || (p.totalBlocks as number) < (p.sampledBlocks as number)) throw new Error('저장된 비교 논문 형식이 올바르지 않습니다');
    return { id: text(p.id, 200), title: text(p.title, 2000), sampledBlocks: p.sampledBlocks as number, totalBlocks: p.totalBlocks as number };
  });
  validateComparisonIds(papers.map((p) => p.id));
  // Validate structural/evidence constraints against the saved literal quotes themselves.
  const inputs: ComparisonInputPaper[] = papers.map((p) => ({ id: p.id, blocks: [] }));
  if (!Array.isArray(raw.sections)) throw new Error('저장된 비교 항목이 없습니다');
  for (const section of raw.sections) {
    if (!object(section) || !Array.isArray(section.papers)) throw new Error('저장된 비교 항목이 올바르지 않습니다');
    const claims = [...section.papers.map((p) => object(p) ? p.claim : null), section.synthesis];
    for (const c of claims) {
      if (!object(c) || !Array.isArray(c.sources)) throw new Error('저장된 비교 근거가 올바르지 않습니다');
      for (const s of c.sources) {
        if (!object(s) || !Number.isInteger(s.blockIdx) || (s.blockIdx as number) < 0 || !Number.isInteger(s.start) || (s.start as number) < 0 || !Number.isInteger(s.end) || typeof s.quote !== 'string' || s.end !== (s.start as number) + s.quote.length) throw new Error('저장된 비교 근거 위치가 올바르지 않습니다');
        const input = inputs.find((p) => p.id === s.paperId);
        if (!input) throw new Error('저장된 비교 근거 논문이 없습니다');
        input.blocks.push({ idx: s.blockIdx as number, page: s.page as number, text: s.quote, isRef: false });
      }
    }
  }
  validateComparisonGeneration(raw, inputs);
  const by: MadeBy = { engine: raw.by.engine as MadeBy['engine'] };
  if (raw.by.model !== undefined) by.model = typeof raw.by.model === 'string' ? raw.by.model : text(null);
  if (raw.by.effort !== undefined) by.effort = typeof raw.by.effort === 'string' ? raw.by.effort : text(null);
  return { version: 1, id: text(raw.id, 200), createdAt: text(raw.createdAt, 100), by, papers, sections: raw.sections as unknown as ComparisonSection[] };
}
