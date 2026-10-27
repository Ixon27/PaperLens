import { db, getBlocks, getPaper, isTranslatable, type PaperRow } from '../db';
import { startJob, type JobCtx } from '../jobs';
import { parseJsonLoose } from '../json';
import { resolveModel, runLlm, type ModelSpec } from '../llm';
import { abstractOrPageOne } from '../pdf/context';
import { splitSentences } from '../pdf/sentences';
import { fill, loadPrompt } from '../prompts';

const MAX_BLOCKS = 40;
const MAX_CHARS = 12_000;
/** One CLI slot stays free for chat and term lookups while a paper translates. */
const PAGE_CONCURRENCY = 2;
const JSON_ONLY_SUFFIX = '\n\n(설명 없이 JSON 객체 하나만 출력하라.)';

export interface BatchBlock {
  idx: number;
  text: string;
  /** Sentence ranges of `text`; the model translates sentence by sentence. */
  sentences: Array<[number, number]>;
}

export interface PageWork {
  page: number;
  /** ≤40 blocks / ≤12,000 chars each (a single oversized block gets its own batch). */
  batches: BatchBlock[][];
}

/** One translated sentence and the source characters `[start, end)` it translates. */
export interface KoSentence {
  start: number;
  end: number;
  ko: string;
}

export interface BlockTranslation {
  ko: string;
  /** null when the model did not return one translation per source sentence. */
  sentences: KoSentence[] | null;
  by: ModelSpec;
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
    list.push({ idx: b.idx, text: b.text, sentences: splitSentences(b.text) });
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
 * One block's model output → its Korean text, plus per-sentence pairs when the model returned
 * exactly one translation per source sentence. null when there is nothing usable.
 */
export function alignTranslation(
  ranges: Array<[number, number]>,
  value: unknown,
): { ko: string; sentences: Array<[number, number, string]> | null } | null {
  if (typeof value === 'string') {
    const ko = value.trim();
    return ko ? { ko, sentences: null } : null;
  }
  if (!Array.isArray(value)) return null;
  const trimmed = value.map((v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''));
  const nonEmpty = trimmed.filter(Boolean);
  if (!nonEmpty.length) return null;
  return {
    ko: nonEmpty.join(' '),
    sentences: trimmed.length === ranges.length ? ranges.map(([s, e], i): [number, number, string] => [s, e, trimmed[i]]) : null,
  };
}

/**
 * Translate one batch and store the result. Returns the saved translations by block index, or null
 * when the response could not be parsed twice (those blocks stay untranslated). LLM errors/cancel throw.
 */
export async function translateBatch(
  paper: Pick<PaperRow, 'id' | 'title' | 'abstract'>,
  batch: BatchBlock[],
  by: ModelSpec,
  signal?: AbortSignal,
): Promise<Record<string, BlockTranslation> | null> {
  const P = loadPrompt('translate');
  const system = fill(P.SYSTEM, { title: paper.title, abstract: abstractOrPageOne(paper) });
  const blocksJson = JSON.stringify(Object.fromEntries(batch.map((b) => [String(b.idx), b.sentences.map(([s, e]) => b.text.slice(s, e))])));
  const prompt = fill(P.PAGE, { blocks_json: blocksJson });

  let result: Record<string, unknown> | null = null;
  for (const p of [prompt, prompt + JSON_ONLY_SUFFIX]) {
    const { text } = await runLlm({ system, prompt: p, profile: 'quick', model: by, signal });
    try {
      result = parseTranslations(text);
      break;
    } catch {
      // retry once with the JSON-only suffix
    }
  }
  if (!result) return null;

  const saved: Record<string, BlockTranslation> = {};
  const madeBy = JSON.stringify(by);
  const insert = db.prepare('INSERT OR REPLACE INTO translations(paper_id, block_idx, ko, sentences, made_by) VALUES(?,?,?,?,?)');
  for (const b of batch) {
    const key = String(b.idx);
    const aligned = alignTranslation(b.sentences, result[key]);
    if (!aligned) continue;
    insert.run(paper.id, b.idx, aligned.ko, aligned.sentences ? JSON.stringify(aligned.sentences) : null, madeBy);
    saved[key] = {
      ko: aligned.ko,
      sentences: aligned.sentences?.map(([start, end, ko]) => ({ start, end, ko })) ?? null,
      by,
    };
  }
  return saved;
}

async function runTranslation(paperId: string, force: boolean, ctx: JobCtx) {
  const paper = getPaper(paperId);
  if (!paper) throw new Error('논문을 찾을 수 없습니다');
  if (force) db.prepare('DELETE FROM translations WHERE paper_id=?').run(paperId);

  const pages = pendingPages(paperId);
  if (!pages.length) return;
  const by = resolveModel('quick');

  // One worker failing (LLM error) stops the others too.
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  ctx.signal.addEventListener('abort', onAbort);

  let next = 0;
  let pagesDone = 0;
  const worker = async () => {
    while (next < pages.length) {
      if (stop.signal.aborted) return;
      const { page, batches } = pages[next++];
      const translations: Record<string, BlockTranslation> = {};
      let failed = false;
      for (const batch of batches) {
        if (stop.signal.aborted) return;
        const saved = await translateBatch(paper, batch, by, stop.signal);
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
