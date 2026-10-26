import { Hono } from 'hono';
import { HttpError } from '../http-error';
import * as openalex from '../services/openalex';
import { libraryIdForDoi } from '../tasks/related';

export const openalexRoutes = new Hono();

const MAX_CACHE = 500;
/** Insertion-ordered Map as an LRU: hits are re-inserted, the oldest key is evicted. */
const cache = new Map<string, openalex.WorkSummary>();

function cacheGet(key: string): openalex.WorkSummary | undefined {
  const v = cache.get(key);
  if (v) {
    cache.delete(key);
    cache.set(key, v);
  }
  return v;
}

function cacheSet(key: string, v: openalex.WorkSummary) {
  cache.delete(key);
  cache.set(key, v);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
}

openalexRoutes.get('/openalex/lookup', async (c) => {
  const doi = c.req.query('doi')?.trim().toLowerCase();
  const title = c.req.query('title')?.trim();
  if (!doi && !title) throw new HttpError(400, 'doi 또는 title 이 필요합니다');
  const key = doi ? `doi:${doi}` : `title:${title!.toLowerCase()}`;
  let summary = cacheGet(key);
  if (!summary) {
    let w: openalex.OpenAlexWork | null;
    try {
      w = doi ? await openalex.getByDoi(doi) : await openalex.search(title!);
    } catch {
      throw new HttpError(502, 'OpenAlex 조회에 실패했습니다');
    }
    if (!w) throw new HttpError(404, 'OpenAlex에서 찾지 못했습니다');
    summary = openalex.toSummary(w);
    cacheSet(key, summary);
  }
  return c.json({ ...summary, inLibrary: libraryIdForDoi(summary.doi) });
});
