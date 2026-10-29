import { getArtifact, putArtifact, type PaperRow } from '../db';
import { HttpError } from '../http-error';
import * as openalex from '../services/openalex';
import { paperIdByDoi, paperIdByOpenAlex } from './import';

type Source = 'related' | 'recentCiting' | 'topCiting' | 'topic';

interface RelatedRaw {
  fetchedAt: string;
  related: openalex.WorkSummary[];
  recentCiting: openalex.WorkSummary[];
  topCiting: openalex.WorkSummary[];
  topic: { name: string; items: openalex.WorkSummary[] } | null;
  errors: Source[];
}

type WithLib<T> = T & { inLibrary: string | null };

export interface RelatedResponse {
  fetchedAt: string;
  related: WithLib<openalex.WorkSummary>[];
  recentCiting: WithLib<openalex.WorkSummary>[];
  topCiting: WithLib<openalex.WorkSummary>[];
  topic: { name: string; items: WithLib<openalex.WorkSummary>[] } | null;
  errors: Source[];
}

const CACHE_MS = 7 * 24 * 3600 * 1000;

export function libraryIdForDoi(doi: string | null | undefined): string | null {
  return doi ? paperIdByDoi(doi.toLowerCase()) : null;
}

function annotate(raw: RelatedRaw): RelatedResponse {
  const lib = <T extends { doi: string | null; openalexId: string }>(items: T[]) => items.map((it) => ({ ...it, inLibrary: paperIdByOpenAlex(it.openalexId) ?? libraryIdForDoi(it.doi) }));
  return {
    fetchedAt: raw.fetchedAt,
    related: lib(raw.related),
    recentCiting: lib(raw.recentCiting),
    topCiting: lib(raw.topCiting),
    topic: raw.topic ? { name: raw.topic.name, items: lib(raw.topic.items) } : null,
    errors: raw.errors,
  };
}

async function collect(w: openalex.OpenAlexWork): Promise<RelatedRaw> {
  const errors: Source[] = [];

  const group = async <T>(source: Source, fn: (work: openalex.OpenAlexWork) => Promise<T[]>): Promise<T[]> => {
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

  let topic: RelatedRaw['topic'] = null;
  if (w.primary_topic) {
    const name = w.primary_topic.display_name;
    try {
      topic = { name, items: (await openalex.recentInTopic(w.primary_topic.id, w.id)).map(openalex.toSummary) };
    } catch {
      topic = { name, items: [] };
      errors.push('topic');
    }
  }

  // Order the groups' errors consistently.
  const order: Source[] = ['related', 'recentCiting', 'topCiting', 'topic'];
  return { fetchedAt: new Date().toISOString(), related, recentCiting, topCiting, topic, errors: order.filter((s) => errors.includes(s)) };
}

/** Related papers from OpenAlex, cached 7 days in artifacts(kind='related'). */
export async function getRelated(paper: PaperRow, refresh: boolean): Promise<RelatedResponse> {
  if (!refresh) {
    const cached = getArtifact(paper.id, 'related');
    if (cached && Date.now() - Date.parse(cached.updated_at) < CACHE_MS) {
      try {
        const raw = JSON.parse(cached.content) as RelatedRaw;
        if (raw && typeof raw === 'object' && 'topic' in raw) return annotate(raw);
      } catch {
        // fall through to a fresh fetch
      }
    }
  }
  const work = await openalex.findWork(paper);
  if (!work) throw new HttpError(404, 'OpenAlex에서 이 논문을 찾지 못했습니다 — 정보 수정에서 DOI를 확인하세요');
  const raw = await collect(work);
  putArtifact(paper.id, 'related', JSON.stringify(raw), {}, null);
  return annotate(raw);
}
