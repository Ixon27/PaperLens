import { getJson } from './http';
import { stripMarkup } from './crossref';

const BASE = 'https://api.openalex.org';

export interface OpenAlexWork {
  id: string;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  cited_by_count?: number;
  abstract_inverted_index?: Record<string, number[]> | null;
  primary_location?: { source?: { display_name?: string } | null } | null;
  best_oa_location?: { pdf_url?: string | null } | null;
  locations?: { pdf_url?: string | null; is_oa?: boolean }[];
  primary_topic?: { id: string; display_name: string } | null;
  ids?: { pmid?: string; pmcid?: string };
  keywords?: { display_name: string }[];
  related_works?: string[];
  referenced_works?: string[];
  authorships?: { author?: { display_name?: string } }[];
}

export interface WorkSummary {
  openalexId: string;
  doi: string | null;
  title: string;
  year: number | null;
  venue: string | null;
  citedBy: number;
  abstract: string | null;
  oaPdf: string | null;
  pmid: string | null;
  pmcid: string | null;
  keywords: string[];
  authors: string[];
}

export const shortId = (id: string) => id.replace(/^https?:\/\/openalex\.org\//, '');
export const titleKey = (title: string) => stripMarkup(title).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function rebuildAbstract(inv: Record<string, number[]> | null | undefined): string | null {
  if (!inv) return null;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(inv)) for (const p of positions) words[p] = word;
  const text = words.filter((w) => w !== undefined).join(' ').trim();
  return text || null;
}

export function toSummary(w: OpenAlexWork): WorkSummary {
  return {
    openalexId: shortId(w.id),
    doi: w.doi ? w.doi.replace(/^https?:\/\/doi\.org\//i, '').toLowerCase() : null,
    title: stripMarkup(w.title ?? w.display_name ?? ''),
    year: w.publication_year ?? null,
    venue: w.primary_location?.source?.display_name ?? null,
    citedBy: w.cited_by_count ?? 0,
    abstract: rebuildAbstract(w.abstract_inverted_index),
    oaPdf: w.best_oa_location?.pdf_url ?? w.locations?.find((location) => location.is_oa && location.pdf_url)?.pdf_url ?? null,
    pmid: w.ids?.pmid?.replace(/^.*\//, '') ?? null,
    pmcid: w.ids?.pmcid ? 'PMC' + w.ids.pmcid.replace(/^.*\//, '').replace(/^PMC/i, '') : null,
    keywords: (w.keywords ?? []).map((k) => k.display_name),
    authors: (w.authorships ?? []).map((a) => a.author?.display_name ?? '').filter(Boolean),
  };
}

export async function getByDoi(doi: string): Promise<OpenAlexWork | null> {
  return getJson<OpenAlexWork>(`${BASE}/works/doi:${encodeURIComponent(doi)}`);
}

export async function getById(id: string): Promise<OpenAlexWork | null> {
  return getJson<OpenAlexWork>(`${BASE}/works/${shortId(id)}`);
}

export async function getMany(ids: string[]): Promise<OpenAlexWork[]> {
  const works: OpenAlexWork[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const filter = ids.slice(i, i + 50).map(shortId).join('|');
    const res = await getJson<{ results: OpenAlexWork[] }>(`${BASE}/works?filter=openalex_id:${filter}&per-page=50`);
    works.push(...(res?.results ?? []));
  }
  return works;
}

export async function search(title: string): Promise<OpenAlexWork | null> {
  const res = await getJson<{ results: OpenAlexWork[] }>(`${BASE}/works?search=${encodeURIComponent(title)}&per-page=1`);
  return res?.results?.[0] ?? null;
}

export async function findWork(p: { openalex_id: string | null; doi: string | null; title: string }): Promise<OpenAlexWork | null> {
  const byId = p.openalex_id ? await getById(p.openalex_id).catch(() => null) : null;
  if (byId) return byId;
  const byDoi = p.doi ? await getByDoi(p.doi).catch(() => null) : null;
  if (byDoi) return byDoi;
  const found = await search(p.title).catch(() => null);
  return found && titleKey(found.title ?? found.display_name ?? '') === titleKey(p.title) ? found : null;
}

export async function recentInTopic(topicId: string, excludeId: string): Promise<OpenAlexWork[]> {
  const res = await getJson<{ results: OpenAlexWork[] }>(
    `${BASE}/works?filter=primary_topic.id:${shortId(topicId)},from_publication_date:${new Date().getFullYear() - 2}-01-01&sort=publication_date:desc&per-page=11`,
  );
  return (res?.results ?? []).filter((work) => shortId(work.id) !== shortId(excludeId)).slice(0, 10);
}

export async function citing(wid: string, sort: string): Promise<OpenAlexWork[]> {
  const res = await getJson<{ results: OpenAlexWork[] }>(
    `${BASE}/works?filter=cites:${shortId(wid)}&sort=${encodeURIComponent(sort)}&per-page=10`,
  );
  return res?.results ?? [];
}
