import { getPaper, putArtifact } from '../db';
import { startJob } from '../jobs';
import { parseJsonLoose } from '../json';
import { runLlm } from '../llm';
import { paperSystem } from '../pdf/context';
import { loadPrompt } from '../prompts';
import { getSettings } from '../settings';

export const MIND_KINDS = ['background', 'question', 'method', 'finding', 'limitation', 'concept'] as const;
export type MindKind = (typeof MIND_KINDS)[number];

export interface MindNode {
  label: string;
  kind?: MindKind;
  bullets?: string[];
  pages?: number[];
  children?: MindNode[];
}

export interface MindmapContent {
  root: MindNode;
  positions: Record<string, { x: number; y: number }>;
}

const MAX_DEPTH = 3; // levels below the root
const MAX_NODES = 40; // including the root
const JSON_ONLY = '\n\n(설명 없이 JSON 객체 하나만 출력하라.)';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function cleanNode(raw: Record<string, unknown>, pageCount: number): MindNode {
  const node: MindNode = { label: String(raw.label).trim() };
  if (typeof raw.kind === 'string' && (MIND_KINDS as readonly string[]).includes(raw.kind)) node.kind = raw.kind as MindKind;
  if (Array.isArray(raw.bullets)) {
    const bullets = raw.bullets.filter((b): b is string => typeof b === 'string' && b.trim() !== '').map((b) => b.trim());
    if (bullets.length) node.bullets = bullets;
  }
  if (Array.isArray(raw.pages)) {
    const pages = [...new Set(raw.pages.filter((p): p is number => Number.isInteger(p) && p >= 1 && p <= pageCount))];
    if (pages.length) node.pages = pages;
  }
  return node;
}

const hasLabel = (v: unknown): v is Record<string, unknown> => isObj(v) && typeof v.label === 'string' && v.label.trim() !== '';

/**
 * Normalize a model-produced tree: root + at most 3 levels, at most 40 nodes kept in BFS order,
 * `kind` limited to the known values, `bullets` strings only, `pages` deduped integers in 1..pageCount.
 * Returns null when there is no usable root.
 */
export function validateMindmap(parsed: unknown, pageCount: number): MindNode | null {
  const rawRoot = isObj(parsed) ? parsed.root : undefined;
  if (!hasLabel(rawRoot)) return null;
  const root = cleanNode(rawRoot, pageCount);
  let count = 1;
  const queue: { raw: Record<string, unknown>; node: MindNode; depth: number }[] = [{ raw: rawRoot, node: root, depth: 0 }];
  for (let i = 0; i < queue.length; i++) {
    const { raw, node, depth } = queue[i];
    if (depth >= MAX_DEPTH || !Array.isArray(raw.children)) continue;
    for (const c of raw.children) {
      if (count >= MAX_NODES) break;
      if (!hasLabel(c)) continue;
      const child = cleanNode(c, pageCount);
      (node.children ??= []).push(child);
      count++;
      queue.push({ raw: c, node: child, depth: depth + 1 });
    }
  }
  return root;
}

function tryParse(text: string, pageCount: number): MindNode | null {
  try {
    return validateMindmap(parseJsonLoose<unknown>(text), pageCount);
  } catch {
    return null;
  }
}

export function startMindmap(paperId: string): string {
  return startJob(paperId, 'mindmap', async (ctx) => {
    const paper = getPaper(paperId);
    if (!paper) throw new Error('논문을 찾을 수 없습니다');
    const engine = getSettings().engine;
    const pageCount = paper.page_count ?? 0;
    const system = paperSystem(paper);
    const prompt = loadPrompt('mindmap').PROMPT;
    if (!prompt) throw new Error('prompts/mindmap.md 에 PROMPT 섹션이 없습니다');

    ctx.progress(0.05, '마인드맵 생성 중…');
    let root = tryParse(await runLlm({ system, prompt, profile: 'heavy', signal: ctx.signal }, engine), pageCount);
    if (!root) {
      ctx.progress(0.5, 'JSON 다시 요청 중…');
      root = tryParse(await runLlm({ system, prompt: prompt + JSON_ONLY, profile: 'heavy', signal: ctx.signal }, engine), pageCount);
    }
    if (!root) throw new Error('마인드맵 JSON 파싱 실패');

    const content: MindmapContent = { root, positions: {} };
    putArtifact(paperId, 'mindmap', JSON.stringify(content), {}, engine);
  });
}
