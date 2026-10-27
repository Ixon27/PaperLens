import { getArtifact, getBlocks, getPaper, putArtifact, type BlockRow } from '../db';
import { startJob, type JobCtx } from '../jobs';
import { parseJsonLoose } from '../json';
import { resolveModel, runLlm } from '../llm';
import { fill, loadPrompt } from '../prompts';

export interface RefEntry {
  key: string;
  authors: string | null;
  year: number | null;
  title: string | null;
  journal: string | null;
  doi: string | null;
}

const SYSTEM = '너는 논문 참고문헌 목록을 JSON 으로 정리한다. 원문에 없는 값은 지어내지 않는다.';
const CHUNK_CHARS = 25_000;

/** is_ref blocks; without any, every block from the last ceil(30%) of pages. */
function sourceBlocks(blocks: BlockRow[], pageCount: number): BlockRow[] {
  const refs = blocks.filter((b) => b.is_ref);
  if (refs.length) return refs;
  const pages = pageCount || Math.max(0, ...blocks.map((b) => b.page));
  const from = pages - Math.ceil(pages * 0.3) + 1;
  return blocks.filter((b) => b.page >= from);
}

/** Cut into chunks of ≤25,000 chars on block boundaries (an oversized single block is its own chunk). */
export function chunkBlocks(texts: string[], max = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let cur = '';
  for (const t of texts) {
    if (cur && cur.length + 1 + t.length > max) {
      chunks.push(cur);
      cur = '';
    }
    cur = cur ? cur + '\n' + t : t;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

const str = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  return null;
};

function toEntry(v: unknown): RefEntry | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const key = str(o.key);
  if (!key) return null;
  const y = typeof o.year === 'number' ? o.year : typeof o.year === 'string' ? parseInt(o.year, 10) : NaN;
  const doi = str(o.doi);
  return {
    key,
    authors: str(o.authors),
    year: Number.isFinite(y) ? y : null,
    title: str(o.title),
    journal: str(o.journal),
    doi: doi ? doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/[.,;)]+$/, '').toLowerCase() : null,
  };
}

async function runReferences(paperId: string, ctx: JobCtx) {
  const paper = getPaper(paperId);
  if (!paper) throw new Error('논문을 찾을 수 없습니다');
  const blocks = sourceBlocks(getBlocks(paperId), paper.page_count ?? 0);
  const chunks = chunkBlocks(blocks.map((b) => b.text));
  const P = loadPrompt('references');
  const by = resolveModel('quick');
  ctx.progress(0, '참고문헌 목록 추출 중');
  // All chunks at once (the CLI semaphore bounds concurrency); one failing call stops the rest.
  const stop = new AbortController();
  const signal = AbortSignal.any([ctx.signal, stop.signal]);
  let completed = 0;
  const results = await Promise.all(
    chunks.map(async (chunk): Promise<unknown[] | null> => {
      try {
        const { text } = await runLlm({ system: SYSTEM, prompt: fill(P.PROMPT, { text: chunk }), profile: 'quick', model: by, signal });
        let list: unknown[] | null;
        try {
          const parsed = parseJsonLoose<unknown>(text);
          list = Array.isArray(parsed) ? parsed : [];
        } catch {
          list = null;
          ctx.message('일부 참고문헌 파싱 실패');
        }
        ctx.progress(++completed / chunks.length);
        return list;
      } catch (e) {
        stop.abort();
        throw e;
      }
    }),
  );
  // Merge in chunk order so deduplication does not depend on which call finished first.
  const entries: RefEntry[] = [];
  const seen = new Set<string>();
  let failed = 0;
  for (const list of results) {
    if (!list) {
      failed++;
      continue;
    }
    for (const raw of list) {
      const e = toEntry(raw);
      if (!e || seen.has(e.key)) continue;
      seen.add(e.key);
      entries.push(e);
    }
  }
  putArtifact(paperId, 'references', JSON.stringify(entries), { count: entries.length, failedChunks: failed }, by);
}

export function startReferences(paperId: string): string {
  return startJob(paperId, 'references', (ctx) => runReferences(paperId, ctx));
}

export function loadReferences(paperId: string): RefEntry[] | null {
  const a = getArtifact(paperId, 'references');
  if (!a) return null;
  try {
    const parsed = JSON.parse(a.content) as unknown;
    return Array.isArray(parsed) ? parsed.map(toEntry).filter((e): e is RefEntry => e !== null) : [];
  } catch {
    return [];
  }
}
