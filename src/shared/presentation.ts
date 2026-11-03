import type { MadeBy } from './models';

export const PRESENTATION_MIN_MINUTES = 3;
export const PRESENTATION_MAX_MINUTES = 60;

export interface PresentationSource {
  page: number;
  quote: string;
  blockIdx: number;
  start: number;
  end: number;
}
export interface PresentationBlock { idx: number; page: number; text: string; isRef: boolean }
export interface PresentationEvidence { id: string; source: PresentationSource }
export interface PresentationSlide {
  title: string;
  seconds: number;
  bullets: string[];
  script: string;
  sources: PresentationSource[];
}
export interface PresentationQuestion { question: string; answer: string; sources: PresentationSource[] }
export interface PresentationDraft { title: string; slides: PresentationSlide[]; questions: PresentationQuestion[] }
export interface PresentationAnalysis {
  status: 'none' | 'partial' | 'complete' | 'unknown';
  updatedAt: string | null;
  callsDone: number | null;
  truncated: boolean;
}
export interface PresentationContent extends PresentationDraft {
  version: 1;
  paperTitle: string;
  durationMinutes: number;
  createdAt: string;
  by: MadeBy;
  analysis: PresentationAnalysis;
}
export interface PresentationResponse { presentation: PresentationContent | null; analysis: PresentationAnalysis }

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function text(v: unknown, name: string, max: number): string {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max) throw new Error(`${name} 형식이 올바르지 않습니다`);
  return v.trim();
}
function list<T>(v: unknown, name: string, min: number, max: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) throw new Error(`${name}은(는) ${min}~${max}개여야 합니다`);
  return v.map(parse);
}
export function validatePresentationDuration(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < PRESENTATION_MIN_MINUTES || v > PRESENTATION_MAX_MINUTES) throw new Error(`발표 시간은 ${PRESENTATION_MIN_MINUTES}~${PRESENTATION_MAX_MINUTES}분 사이의 정수여야 합니다`);
  return v;
}

/** Give the model stable IDs instead of asking it to reproduce PDF typography verbatim. */
export function presentationEvidence(blocks: readonly PresentationBlock[]): PresentationEvidence[] {
  const evidence: PresentationEvidence[] = [];
  let included = 0;
  for (const block of blocks) {
    if (block.isRef) continue;
    let segment = 0;
    for (let offset = 0; offset < block.text.length;) {
      let end = Math.min(offset + 1800, block.text.length);
      if (end < block.text.length) {
        const gap = block.text.lastIndexOf(' ', end);
        if (gap > offset + 1000) end = gap;
      }
      const excerpt = block.text.slice(offset, end);
      const quote = excerpt.trim();
      const start = offset + excerpt.indexOf(quote);
      offset = end;
      if (quote.replace(/\s/g, '').length < 12) continue;
      if (included + quote.length > 350_000) return evidence;
      evidence.push({ id: `b${block.idx}.${segment++}`, source: { page: block.page, quote, blockIdx: block.idx, start, end: start + quote.length } });
      included += quote.length;
    }
  }
  return evidence;
}
function storedSource(raw: unknown): PresentationSource {
  if (!object(raw) || ![raw.page, raw.blockIdx, raw.start, raw.end].every((v) => typeof v === 'number' && Number.isInteger(v))) throw new Error('저장된 발표 근거가 올바르지 않습니다');
  const { page, blockIdx, start, end } = raw as unknown as PresentationSource;
  if (page < 1 || blockIdx < 0 || start < 0 || end <= start) throw new Error('저장된 발표 근거 위치가 올바르지 않습니다');
  const quote = text(raw.quote, '근거 인용문', 2000);
  if (end - start !== quote.length) throw new Error('저장된 발표 근거 길이가 올바르지 않습니다');
  return { page, blockIdx, start, end, quote };
}
function draft(raw: unknown, duration: number, parseSource: (v: unknown) => PresentationSource): PresentationDraft {
  if (!object(raw)) throw new Error('발표 자료 형식이 올바르지 않습니다');
  const slides = list(raw.slides, '슬라이드', 3, 30, (v): PresentationSlide => {
    if (!object(v) || typeof v.seconds !== 'number' || !Number.isInteger(v.seconds) || v.seconds < 10 || v.seconds > 600) throw new Error('슬라이드 시간은 10~600초 사이의 정수여야 합니다');
    return { title: text(v.title, '슬라이드 제목', 300), seconds: v.seconds, bullets: list(v.bullets, '핵심 항목', 1, 6, (b) => text(b, '핵심 항목', 1200)), script: text(v.script, '발표 대본', 18000), sources: list(v.sources, '슬라이드 근거', 1, 5, parseSource) };
  });
  if (slides.reduce((sum, slide) => sum + slide.seconds, 0) !== duration * 60) throw new Error('슬라이드 시간의 합이 요청한 발표 시간과 다릅니다');
  const questions = list(raw.questions, '예상 질문', 3, 8, (v): PresentationQuestion => {
    if (!object(v)) throw new Error('예상 질문 형식이 올바르지 않습니다');
    return { question: text(v.question, '예상 질문', 1500), answer: text(v.answer, '예상 답변', 6000), sources: list(v.sources, '질문 근거', 1, 5, parseSource) };
  });
  return { title: text(raw.title, '발표 제목', 300), slides, questions };
}
/** Only IDs from the supplied paper snapshot can become persisted source evidence. */
export function validatePresentationGeneration(raw: unknown, evidence: readonly PresentationEvidence[], duration: number): PresentationDraft {
  const sources = new Map(evidence.map((entry) => [entry.id, entry.source]));
  return draft(raw, validatePresentationDuration(duration), (id) => {
    if (typeof id !== 'string' || !sources.has(id)) throw new Error('논문 본문에서 확인할 수 없는 발표 근거 ID입니다');
    return { ...sources.get(id)! };
  });
}

/** Read synced artifacts without fabricating missing provenance or replacing corrupt content. */
export function parsePresentationContent(raw: unknown): PresentationContent {
  if (!object(raw) || raw.version !== 1 || !object(raw.by) || (raw.by.engine !== 'claude' && raw.by.engine !== 'codex') || !object(raw.analysis)) throw new Error('저장된 발표 자료 형식을 읽을 수 없습니다');
  const durationMinutes = validatePresentationDuration(raw.durationMinutes);
  const by: MadeBy = { engine: raw.by.engine };
  for (const field of ['model', 'effort'] as const) {
    if (raw.by[field] !== undefined) {
      if (typeof raw.by[field] !== 'string') throw new Error('저장된 모델 정보가 올바르지 않습니다');
      by[field] = raw.by[field];
    }
  }
  const a = raw.analysis;
  if (!['none', 'partial', 'complete', 'unknown'].includes(String(a.status)) || !(a.updatedAt === null || typeof a.updatedAt === 'string') || !(a.callsDone === null || (typeof a.callsDone === 'number' && Number.isInteger(a.callsDone) && a.callsDone >= 0 && a.callsDone <= 3)) || typeof a.truncated !== 'boolean') throw new Error('저장된 분석 상태가 올바르지 않습니다');
  return { version: 1, ...draft(raw, durationMinutes, storedSource), paperTitle: text(raw.paperTitle, '논문 제목', 3000), durationMinutes, createdAt: text(raw.createdAt, '생성 시각', 100), by, analysis: { status: a.status as PresentationAnalysis['status'], updatedAt: a.updatedAt, callsDone: a.callsDone as number | null, truncated: a.truncated } };
}

export function presentationAnalysisLabel(analysis: PresentationAnalysis): string {
  const status = analysis.status === 'none' ? '저장된 분석 없음 · 논문 원문만 사용' : analysis.status === 'partial' ? `일부 저장된 분석 사용 (${analysis.callsDone}/3)` : analysis.status === 'complete' ? '저장된 분석 사용 (3/3)' : '저장된 분석 사용 · 완성 여부 미확인';
  return status + (analysis.truncated ? ' · 긴 분석의 앞부분만 사용' : '');
}
const singleLine = (s: string) => s.replace(/[\r\n]+/g, ' ');
export function presentationMarkdown(content: PresentationContent): string {
  const model = content.by.model === undefined ? '미기록' : content.by.model || 'CLI 기본값';
  const effort = content.by.effort === undefined ? '미기록' : content.by.effort || 'CLI 기본값';
  const lines = [`# ${singleLine(content.title)}`, '', `논문: ${singleLine(content.paperTitle)}`, `발표 시간: ${content.durationMinutes}분 (질의응답 별도)`, `생성: ${content.createdAt}`, `모델: ${content.by.engine} / ${singleLine(model)}`, `요청 effort 설정: ${singleLine(effort)} (실제 내부 추론량은 확인할 수 없음)`, `분석: ${presentationAnalysisLabel(content.analysis)}`, ...(content.analysis.updatedAt ? [`분석 저장 시각: ${content.analysis.updatedAt}`] : []), '', '시간 배분은 계획이며 실제 낭독 시간은 리허설로 확인하세요.', ''];
  const evidence = (sources: PresentationSource[]) => sources.flatMap((s) => [`- 원문 p.${s.page} (본문 블록 ${s.blockIdx})`, ...s.quote.split(/\r?\n/).map((line) => `  > ${line}`)]);
  let elapsed = 0;
  content.slides.forEach((slide, index) => {
    lines.push(`## ${index + 1}. ${singleLine(slide.title)}`, '', `시간: ${elapsed}–${elapsed + slide.seconds}초 (${slide.seconds}초)`, '', '### 슬라이드 개요', '', ...slide.bullets.map((b) => `- ${b.replace(/\r?\n/g, '\n  ')}`), '', '### 발표 대본', '', slide.script, '', '### 원문 근거', '', ...evidence(slide.sources), '');
    elapsed += slide.seconds;
  });
  lines.push('## 예상 질문과 답변', '');
  content.questions.forEach((q, index) => lines.push(`### ${index + 1}. ${singleLine(q.question)}`, '', q.answer, '', ...evidence(q.sources), ''));
  return lines.join('\n');
}
