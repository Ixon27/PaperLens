import { getPaper, putArtifact } from '../db';
import { startJob } from '../jobs';
import { resolveModel, runLlm, type ModelSpec } from '../llm/index';
import { paperSystem } from '../pdf/context';
import { fill, loadPrompt } from '../prompts';
import { getSettings } from '../settings';
import { resolveField, type FieldId } from '../../shared/fields';
import { fieldPrompt } from '../fields';

export const RETRY_SUFFIX = '\n\n(다시. 설명하지 말고 위 #### 소제목을 글자 그대로 쓴 본문만 출력하라.)';
const TEXT_THROTTLE_MS = 200;

/** Reading order of the analysis; a section belongs to the first entry its `####` title starts with. */
export const SECTION_ORDER = ['요약', 'Why', 'Abstract', 'Introduction', 'Methods', 'Results', '본문', 'Discussion', '한계점', '핵심 개념 심층', '연구 적용'];

/** Sections earlier prompts wrote and the analysis no longer shows (definitions live in the 키워드 사전). */
const RETIRED = ['읽기 로드맵', '공부 단어장'];
/** Earlier section names → current ones, so analyses made before a rename read like new ones. */
const RENAMED: Record<string, string> = {
  '한 줄 메시지': '요약',
  '무엇을 왜 했나': 'Why',
  '연구 배경과 질문': 'Why',
  '내 연구에 쓸 지점': '연구 적용',
};
const RETIRED_SUBHEADING = /^#{5,6}\s+공부 단어장\s*$/;

export interface AnalysisMeta {
  field: FieldId;
  callsDone: number;
  by: ModelSpec;
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^####\s+(.+)$/;

interface Section {
  title: string | null;
  lines: string[];
}

/** `Methods — 따라 하면…` → `Methods`, `Abstract 뜯어보기` → `Abstract`, `한 줄 메시지` → `요약`. */
export function sectionTitle(raw: string): string {
  const title = raw.replace(/\s+[—–-]\s+.*$/, '').replace(/\s+뜯어보기$/, '').trim();
  return RENAMED[title] ?? title;
}

/** `####` sections of one call's output; text before the first heading stays with the first section. */
function sectionsOf(part: string): Section[] {
  const sections: Section[] = [];
  const preamble: string[] = [];
  let fence = false;
  for (const line of part.split('\n')) {
    if (FENCE.test(line)) fence = !fence;
    const m = fence ? null : HEADING.exec(line);
    if (m) {
      const title = sectionTitle(m[1]);
      sections.push({ title, lines: [`#### ${title}`] });
    } else if (fence || !RETIRED_SUBHEADING.test(line)) (sections.at(-1)?.lines ?? preamble).push(line);
  }
  const lead = preamble.join('\n').trim();
  if (!sections.length) return lead ? [{ title: null, lines: [lead] }] : [];
  if (lead) sections[0].lines.unshift(lead, '');
  return sections;
}

/**
 * Merge the calls' outputs in SECTION_ORDER (unknown sections follow in their original order), under
 * the current section names and without retired sections. Also applied to stored analyses on read.
 */
export function orderSections(parts: string[]): string {
  const rank = (title: string | null) => {
    const i = title === null ? -1 : SECTION_ORDER.findIndex((name) => title.startsWith(name));
    return i === -1 ? SECTION_ORDER.length : i;
  };
  return parts
    .flatMap(sectionsOf)
    .filter((s) => s.title === null || !RETIRED.some((name) => s.title!.startsWith(name)))
    .map((s, i) => ({ text: s.lines.join('\n').trim(), key: rank(s.title), i }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map((s) => s.text)
    .join('\n\n');
}

/** Start (or reuse) the structured analysis job (three calls at once); returns the job id. */
export function startAnalysis(paperId: string): string {
  return startJob(paperId, 'analysis', async (ctx) => {
    const paper = getPaper(paperId);
    if (!paper) throw new Error('논문을 찾을 수 없습니다');
    const settings = getSettings();
    const by = resolveModel('heavy', settings);

    const P = loadPrompt('analysis');
    const field = resolveField(paper.field, paper.field_suggested);
    const head = fill(P.COMMON, { title: paper.title, context: settings.readerContext });
    const system = paperSystem(paper);

    // Three calls stream at once, so the live text is rebuilt from their parts instead of appended.
    const parts = ['', '', ''];
    const completed = [false, false, false];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const showText = () => {
      timer = undefined;
      ctx.setText(parts.filter(Boolean).join('\n\n'));
    };
    const scheduleText = () => {
      timer ??= setTimeout(showText, TEXT_THROTTLE_MS);
    };

    const runCall = async (j: number) => {
      const prompt = head + '\n\n---\n\n' + fill(P['CALL ' + j], {
        methods: fieldPrompt(field, 'METHODS'),
        results: P['RESULTS:default'],
        review_methods: P['METHODS:review'],
        review_results: P['RESULTS:review'],
      });
      const call = async (p: string) => {
        parts[j - 1] = '';
        const onDelta = (t: string) => {
          parts[j - 1] += t;
          scheduleText();
        };
        return (await runLlm({ system, prompt: p, profile: 'heavy', model: by, signal: ctx.signal, onDelta })).text;
      };
      let out = await call(prompt);
      if (!out.includes('####')) out = await call(prompt + RETRY_SUFFIX);
      parts[j - 1] = out.trim();
      completed[j - 1] = true;
      const done = completed.filter(Boolean).length;
      const meta: AnalysisMeta = { field, callsDone: done, by };
      putArtifact(paperId, 'analysis', orderSections(parts.filter((_, i) => completed[i])), meta, by);
      // Codex has no deltas: the finished part is authoritative.
      scheduleText();
      ctx.progress(done / 3, done < 3 ? `분석 ${done}/3 완료` : '분석 완료');
    };

    ctx.progress(0, '분석 세 부분을 동시에 작성 중…');
    const settled = await Promise.allSettled([1, 2, 3].map(runCall));
    clearTimeout(timer);
    ctx.setText(orderSections(parts.filter(Boolean)));
    if (ctx.signal.aborted) throw new Error('취소됨');
    const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) throw failure.reason;
  });
}
