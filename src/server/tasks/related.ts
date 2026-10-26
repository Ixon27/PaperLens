import { getArtifact, putArtifact, type PaperRow } from '../db';
import { HttpError } from '../http-error';
import * as europepmc from '../services/europepmc';
import * as openalex from '../services/openalex';
import { paperIdByDoi } from './import';

type Source = 'related' | 'recentCiting' | 'topCiting' | 'epmc';

interface RelatedRaw {
  fetchedAt: string;
  related: openalex.WorkSummary[];
  recentCiting: openalex.WorkSummary[];
  topCiting: openalex.WorkSummary[];
  epmc: { keywords: string[]; items: europepmc.EpmcItem[] } | null;
  errors: Source[];
}

type WithLib<T> = T & { inLibrary: string | null };

export interface RelatedResponse {
  fetchedAt: string;
  related: WithLib<openalex.WorkSummary>[];
  recentCiting: WithLib<openalex.WorkSummary>[];
  topCiting: WithLib<openalex.WorkSummary>[];
  epmc: { keywords: string[]; items: WithLib<europepmc.EpmcItem>[] } | null;
  errors: Source[];
}

const CACHE_MS = 7 * 24 * 3600 * 1000;

export function libraryIdForDoi(doi: string | null | undefined): string | null {
  return doi ? paperIdByDoi(doi.toLowerCase()) : null;
}

function annotate(raw: RelatedRaw): RelatedResponse {
  const lib = <T extends { doi: string | null }>(items: T[]) => items.map((it) => ({ ...it, inLibrary: libraryIdForDoi(it.doi) }));
  return {
    fetchedAt: raw.fetchedAt,
    related: lib(raw.related),
    recentCiting: lib(raw.recentCiting),
    topCiting: lib(raw.topCiting),
    epmc: raw.epmc ? { keywords: raw.epmc.keywords, items: lib(raw.epmc.items) } : null,
    errors: raw.errors,
  };
}

async function collect(paper: PaperRow): Promise<RelatedRaw> {
  const errors: Source[] = [];
  let w: openalex.OpenAlexWork | null = null;
  try {
    w = paper.doi ? await openalex.getByDoi(paper.doi) : null;
    if (!w && paper.openalex_id) w = await openalex.getById(paper.openalex_id);
  } catch {
    w = null;
  }

  const group = async <T>(source: Source, fn: (work: openalex.OpenAlexWork) => Promise<T[]>): Promise<T[]> => {
    if (!w) {
      errors.push(source);
      return [];
    }
    try {
      return await fn(w);
    } catch {
      errors.push(source);
      return [];
    }
  };

  const [related, recentCiting, topCiting] = await Promise.all([
    group('related', async (work) => (await openalex.getMany((work.related_works ?? []).slice(0, 15))).map(openalex.toSummary)),
    group('recentCiting', async (work) => (await openalex.citing(work.id, 'publication_date:desc')).map(openalex.toSummary)),
    group('topCiting', async (work) => (await openalex.citing(work.id, 'cited_by_count:desc')).map(openalex.toSummary)),
  ]);

  let epmc: RelatedRaw['epmc'] = null;
  if (!w) {
    errors.push('epmc');
  } else {
    const keywords = (w.keywords ?? []).map((k) => k.display_name.replace(/"/g, '').trim()).filter(Boolean).slice(0, 2);
    if (keywords.length) {
      const y = new Date().getFullYear();
      const topic = keywords.length === 2 ? `(TITLE_ABS:"${keywords[0]}" AND TITLE_ABS:"${keywords[1]}")` : `TITLE_ABS:"${keywords[0]}"`;
      try {
        epmc = { keywords, items: await europepmc.search(`${topic} AND PUB_YEAR:[${y - 2} TO ${y}] AND SRC:MED`) };
      } catch {
        epmc = { keywords, items: [] };
        errors.push('epmc');
      }
    }
  }

  // Order the groups' errors consistently.
  const order: Source[] = ['related', 'recentCiting', 'topCiting', 'epmc'];
  return { fetchedAt: new Date().toISOString(), related, recentCiting, topCiting, epmc, errors: order.filter((s) => errors.includes(s)) };
}

/** Related papers (OpenAlex related/citing + Europe PMC recent), cached 7 days in artifacts(kind='related'). */
export async function getRelated(paper: PaperRow, refresh: boolean): Promise<RelatedResponse> {
  if (!paper.doi && !paper.openalex_id) throw new HttpError(400, 'DOI가 없어 관련 논문을 찾을 수 없습니다 — 메타데이터에서 DOI를 입력하세요');
  if (!refresh) {
    const cached = getArtifact(paper.id, 'related');
    if (cached && Date.now() - Date.parse(cached.updated_at) < CACHE_MS) {
      try {
        return annotate(JSON.parse(cached.content) as RelatedRaw);
      } catch {
        // fall through to a fresh fetch
      }
    }
  }
  const raw = await collect(paper);
  putArtifact(paper.id, 'related', JSON.stringify(raw), {}, null);
  return annotate(raw);
}
