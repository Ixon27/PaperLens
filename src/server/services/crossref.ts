import type { Author } from '../db';
import { getJson } from './http';

export interface WorkMeta {
  title: string;
  authors: Author[];
  year: number | null;
  journal: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  abstract: string | null;
}

interface CrossrefWork {
  title?: string[];
  author?: { family?: string; given?: string; name?: string }[];
  issued?: { 'date-parts'?: (number | null)[][] };
  'container-title'?: string[];
  volume?: string;
  issue?: string;
  page?: string;
  abstract?: string;
}

export function stripMarkup(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&(?:amp|lt|gt);/g, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>' })[entity]!).replace(/\s+/g, ' ').trim();
}

export async function getWork(doi: string): Promise<WorkMeta | null> {
  const res = await getJson<{ message: CrossrefWork }>(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  if (!res) return null;
  const w = res.message;
  const abstract = w.abstract?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || null;
  return {
    title: stripMarkup(w.title?.[0] ?? '') || doi,
    authors: (w.author ?? [])
      .map((a) => ({ family: a.family ?? a.name ?? '', given: a.given }))
      .filter((a) => a.family),
    year: w.issued?.['date-parts']?.[0]?.[0] ?? null,
    journal: w['container-title']?.[0] ?? null,
    volume: w.volume ?? null,
    issue: w.issue ?? null,
    pages: w.page ?? null,
    abstract,
  };
}
