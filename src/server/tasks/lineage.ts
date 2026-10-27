import { getPaper, parseAuthors, putArtifact } from '../db';
import { startJob } from '../jobs';
import { parseJsonLoose } from '../json';
import { resolveModel, runLlm } from '../llm';
import { paperSystem } from '../pdf/context';
import { fill, loadPrompt } from '../prompts';
import { getSettings } from '../settings';
import * as openalex from '../services/openalex';
import { loadReferences, runReferences } from './references';

export type LineageRole = 'foundation' | 'method' | 'data' | 'prior' | 'contrast';
export interface LineageNode {
  id: string; side: 'ancestor' | 'paper' | 'descendant'; title: string; year: number | null;
  authors: string; venue: string | null; citedBy: number | null; doi: string | null;
  role: LineageRole | null; note: string;
}
export interface LineageEdge { from: string; to: string }
export interface LineageStrand { label: string; ids: string[] }
export interface LineageContent {
  version: 1; source: 'openalex' | 'references'; summary: string;
  nodes: LineageNode[]; edges: LineageEdge[]; strands: LineageStrand[];
}
type Selection = {
  summary: string; ancestors: { id: string; role: LineageRole; note: string }[];
  descendants: { id: string; note: string }[]; strands: LineageStrand[];
};
const roles: Record<LineageRole, true> = { foundation: true, method: true, data: true, prior: true, contrast: true };
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown, max: number) => typeof v === 'string' ? v.trim().slice(0, max) : '';

export function validateLineage(raw: unknown, ancestorIds: Set<string>, descendantIds: Set<string>): Selection | { error: string } {
  const value = object(raw);
  const ancestors: Selection['ancestors'] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(value.ancestors) ? value.ancestors : []) {
    const v = object(item);
    if (typeof v.id !== 'string' || !ancestorIds.has(v.id) || seen.has(v.id) || typeof v.role !== 'string' || !Object.prototype.hasOwnProperty.call(roles, v.role)) continue;
    seen.add(v.id);
    ancestors.push({ id: v.id, role: v.role as LineageRole, note: text(v.note, 400) });
  }
  if (ancestors.length < 3) return { error: '유효한 선행 연구가 3개보다 적습니다' };
  const descendants: Selection['descendants'] = [];
  const seenDescendants = new Set<string>();
  for (const item of Array.isArray(value.descendants) ? value.descendants : []) {
    const v = object(item);
    if (typeof v.id !== 'string' || !descendantIds.has(v.id) || seenDescendants.has(v.id)) continue;
    seenDescendants.add(v.id);
    descendants.push({ id: v.id, note: text(v.note, 400) });
  }
  const strands: LineageStrand[] = [];
  for (const item of Array.isArray(value.strands) ? value.strands : []) {
    const v = object(item);
    const ids = [...new Set((Array.isArray(v.ids) ? v.ids : []).filter((id): id is string => typeof id === 'string' && seen.has(id)))];
    if (ids.length >= 2) strands.push({ label: text(v.label, 30), ids });
  }
  return { summary: text(value.summary, 2000), ancestors, descendants, strands };
}

type Candidate = { node: LineageNode; work?: openalex.OpenAlexWork; abstract?: string | null };
const fromWork = (work: openalex.OpenAlexWork, id: string, side: 'ancestor' | 'descendant'): Candidate => {
  const s = openalex.toSummary(work);
  return { work, abstract: s.abstract, node: { id, side, title: s.title, year: s.year, authors: s.authors[0] ? s.authors[0] + (s.authors.length > 1 ? ' 외' : '') : '', venue: s.venue, citedBy: work.cited_by_count ?? null, doi: s.doi, role: null, note: '' } };
};
const titleKey = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function startLineage(paperId: string): string {
  return startJob(paperId, 'lineage', async (ctx) => {
    const paper = getPaper(paperId);
    if (!paper) throw new Error('논문을 찾을 수 없습니다');
    const check = () => { if (ctx.signal.aborted) throw new Error('취소됨'); };
    const attempt = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
      try { const result = await fn(); check(); return result; } catch (e) { check(); return fallback; }
    };
    ctx.progress(0.05, 'OpenAlex에서 참고문헌 찾는 중…');
    let work: openalex.OpenAlexWork | null = null;
    if (paper.openalex_id) work = await attempt(() => openalex.getById(paper.openalex_id!), null);
    if (!work && paper.doi) work = await attempt(() => openalex.getByDoi(paper.doi!), null);
    if (!work) {
      const found = await attempt(() => openalex.search(paper.title), null);
      if (found && titleKey(found.title ?? found.display_name ?? '') === titleKey(paper.title)) work = found;
    }
    let source: LineageContent['source'] = 'references';
    let candidates: Candidate[] = [];
    if (work?.referenced_works?.length) {
      const works = await attempt(() => openalex.getMany(work!.referenced_works!.slice(0, 300)), []);
      candidates = works.sort((a, b) => (b.cited_by_count ?? 0) - (a.cited_by_count ?? 0)).slice(0, 120).map((w, i) => fromWork(w, `R${i + 1}`, 'ancestor'));
      if (candidates.length) source = 'openalex';
    }
    if (source === 'references') {
      let refs = loadReferences(paperId);
      if (refs === null) { await runReferences(paperId, ctx); check(); refs = loadReferences(paperId); }
      candidates = (refs ?? []).filter((r) => r.title?.trim()).map((r, i): Candidate => ({ node: { id: `R${i + 1}`, side: 'ancestor', title: r.title!, year: r.year, authors: (r.authors ?? '').slice(0, 60), venue: r.journal, citedBy: null, doi: r.doi, role: null, note: '' } }));
    }
    if (!candidates.length) throw new Error('참고문헌을 찾지 못해 계보를 만들 수 없습니다');
    let descendants: Candidate[] = [];
    if (work) {
      const popular = await attempt(() => openalex.citing(work!.id, 'cited_by_count:desc'), []);
      const recent = await attempt(() => openalex.citing(work!.id, 'publication_date:desc'), []);
      const seen = new Set<string>();
      descendants = [...popular, ...recent].filter((w) => { const id = openalex.shortId(w.id); if (seen.has(id)) return false; seen.add(id); return true; }).slice(0, 12).map((w, i) => fromWork(w, `D${i + 1}`, 'descendant'));
    }
    check();
    ctx.progress(0.35, '계보 정리 중…');
    const line = (c: Candidate) => `${c.node.id} | ${c.node.year ?? ''} | ${c.node.authors} | ${c.node.title} | ${c.node.venue ?? ''} | 인용 ${c.node.citedBy ?? ''}`;
    const settings = getSettings();
    const by = resolveModel('heavy', settings);
    const prompt = fill(loadPrompt('lineage').PROMPT, { title: paper.title, context: settings.readerContext, candidates: candidates.map(line).join('\n'), descendants: descendants.map((d) => `${line(d)} | 초록: ${(d.abstract ?? '').slice(0, 400)}`).join('\n') });
    const system = paperSystem(paper);
    const ancestorIds = new Set(candidates.map((c) => c.node.id));
    const descendantIds = new Set(descendants.map((c) => c.node.id));
    let selection: Selection | null = null;
    let error = '';
    for (let i = 0; i < 2; i++) {
      const retry = i ? `\n\n(다시. 직전 출력은 쓸 수 없었다: ${error}. 설명 없이 JSON 객체 하나만 출력하라.)` : '';
      const result = await runLlm({ system, prompt: prompt + retry, profile: 'heavy', model: by, signal: ctx.signal });
      check();
      try {
        const validated = validateLineage(parseJsonLoose<unknown>(result.text), ancestorIds, descendantIds);
        if ('error' in validated) error = validated.error;
        else { selection = validated; break; }
      } catch (e) { error = e instanceof Error ? e.message : 'JSON 파싱 실패'; }
    }
    if (!selection) throw new Error(`계보를 만들지 못했습니다: ${error}`);
    const selectedAncestors = selection.ancestors.map((a) => ({ ...candidates.find((c) => c.node.id === a.id)!.node, role: a.role, note: a.note }));
    const selectedDescendants = selection.descendants.map((d) => ({ ...descendants.find((c) => c.node.id === d.id)!.node, note: d.note }));
    const authors = parseAuthors(paper);
    const paperNode: LineageNode = { id: 'paper', side: 'paper', title: paper.title, year: paper.year, authors: authors[0] ? authors[0].family + (authors.length > 1 ? ' 외' : '') : '', venue: paper.journal, citedBy: work?.cited_by_count ?? null, doi: paper.doi, role: null, note: '' };
    const edges: LineageEdge[] = [...selectedAncestors.map((n) => ({ from: n.id, to: 'paper' })), ...selectedDescendants.map((n) => ({ from: 'paper', to: n.id }))];
    if (source === 'openalex') {
      const chosen = candidates.filter((c) => selection!.ancestors.some((a) => a.id === c.node.id));
      for (const b of chosen) {
        const refs = new Set((b.work?.referenced_works ?? []).map(openalex.shortId));
        for (const a of chosen) if (a !== b && a.work && refs.has(openalex.shortId(a.work.id))) edges.push({ from: a.node.id, to: b.node.id });
      }
    }
    const content: LineageContent = { version: 1, source, summary: selection.summary, nodes: [...selectedAncestors, paperNode, ...selectedDescendants], edges, strands: selection.strands };
    check();
    putArtifact(paperId, 'lineage', JSON.stringify(content), { source }, by);
  });
}
