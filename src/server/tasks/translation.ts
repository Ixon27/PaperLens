import { db, getBlocks, getPaper, isTranslatable, type PaperRow } from '../db';
import { startJob, type JobCtx } from '../jobs';
import { parseJsonLoose } from '../json';
import { runLlm } from '../llm';
import { abstractOrPageOne } from '../pdf/context';
import { fill, loadPrompt } from '../prompts';

const MAX_BLOCKS = 40;
const MAX_CHARS = 12_000;
const PAGE_CONCURRENCY = 2;
const JSON_ONLY_SUFFIX = '\n\n(설명 없이 JSON 객체 하나만 출력하라.)';

export interface BatchBlock {
  idx: number;
  text: string;
}

export interface PageWork {
  page: number;
  /** ≤40 blocks / ≤12,000 chars each (a single oversized block gets its own batch). */
  batches: BatchBlock[][];
}

/** Translatable blocks without a translation row, grouped per page (page order) and cut into batches. */
export function pendingPages(paperId: string): PageWork[] {
  const done = new Set(
    (db.prepare('SELECT block_idx FROM translations WHERE paper_id=?').all(paperId) as { block_idx: number }[]).map((r) => r.block_idx),
  );
  const byPage = new Map<number, BatchBlock[]>();
  for (const b of getBlocks(paperId)) {
    if (!isTranslatable(b) || done.has(b.idx)) continue;
    const list = byPage.get(b.page) ?? [];
    list.push({ idx: b.idx, text: b.text });
    byPage.set(b.page, list);
  }
  return [...byPage.entries()]
    .sort(([a], [b]) => a - b)
    .map(([page, blocks]) => {
      const batches: BatchBlock[][] = [];
      let cur: BatchBlock[] = [];
      let chars = 0;
      for (const b of blocks) {
        if (cur.length && (cur.length >= MAX_BLOCKS || chars + b.text.length > MAX_CHARS)) {
          batches.push(cur);
          cur = [];
          chars = 0;
        }
        cur.push(b);
        chars += b.text.length;
      }
      if (cur.length) batches.push(cur);
      return { page, batches };
    });
}

function parseTranslations(text: string): Record<string, unknown> {
  const parsed = parseJsonLoose<unknown>(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON 파싱 실패: 객체가 아님');
  return parsed as Record<string, unknown>;
}

/**
 * Translate one batch and store the result. Returns the saved `{idx: ko}` map, or null when the
 * response could not be parsed twice (those blocks stay untranslated). LLM errors/cancel throw.
 */
export async function translateBatch(
  paper: Pick<PaperRow, 'id' | 'title' | 'abstract'>,
  batch: BatchBlock[],
  signal?: AbortSignal,
): Promise<Record<string, string> | null> {
  const P = loadPrompt('translate');
  const system = fill(P.SYSTEM, { title: paper.title, abstract: abstractOrPageOne(paper) });
  const blocksJson = JSON.stringify(Object.fromEntries(batch.map((b) => [String(b.idx), b.text])));
  const prompt = fill(P.PAGE, { blocks_json: blocksJson });

  let result: Record<string, unknown> | null = null;
  for (const p of [prompt, prompt + JSON_ONLY_SUFFIX]) {
    const out = await runLlm({ system, prompt: p, profile: 'quick', signal });
    try {
      result = parseTranslations(out);
      break;
    } catch {
      // retry once with the JSON-only suffix
    }
  }
  if (!result) return null;

  const wanted = new Set(batch.map((b) => String(b.idx)));
  const saved: Record<string, string> = {};
  const insert = db.prepare('INSERT OR REPLACE INTO translations(paper_id, block_idx, ko) VALUES(?,?,?)');
  for (const [key, value] of Object.entries(result)) {
    if (!wanted.has(key) || typeof value !== 'string' || !value.trim()) continue;
    insert.run(paper.id, Number(key), value.trim());
    saved[key] = value.trim();
  }
  return saved;
}

async function runTranslation(paperId: string, force: boolean, ctx: JobCtx) {
  const paper = getPaper(paperId);
  if (!paper) throw new Error('논문을 찾을 수 없습니다');
  if (force) db.prepare('DELETE FROM translations WHERE paper_id=?').run(paperId);

  const pages = pendingPages(paperId);
  if (!pages.length) return;

  // One worker failing (LLM error) stops the other one too.
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  ctx.signal.addEventListener('abort', onAbort);

  let next = 0;
  let pagesDone = 0;
  const worker = async () => {
    while (next < pages.length) {
      if (stop.signal.aborted) return;
      const { page, batches } = pages[next++];
      const translations: Record<string, string> = {};
      let failed = false;
      for (const batch of batches) {
        if (stop.signal.aborted) return;
        const saved = await translateBatch(paper, batch, stop.signal);
        if (saved) Object.assign(translations, saved);
        else failed = true;
      }
      if (failed) ctx.message(`p.${page} 번역 실패 — 다시 번역으로 재시도`);
      ctx.emit('page', { page, translations });
      pagesDone++;
      ctx.progress(pagesDone / pages.length);
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(PAGE_CONCURRENCY, pages.length) }, () =>
        worker().catch((e: unknown) => {
          stop.abort();
          throw e;
        }),
      ),
    );
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

/** Start (or reuse) the translation job for a paper; returns the job id. */
export function startTranslation(paperId: string, { force = false }: { force?: boolean } = {}): string {
  return startJob(paperId, 'translation', (ctx) => runTranslation(paperId, force, ctx));
}
