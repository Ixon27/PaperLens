import type { WorkMeta } from './crossref';
import { getText } from './http';

const tag = (xml: string, name: string) => new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Metadata from the arXiv Atom API, split author names into family/given. */
export async function getById(id: string): Promise<WorkMeta | null> {
  const xml = await getText(`http://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`);
  const entry = xml && tag(xml, 'entry');
  if (!entry) return null;
  const title = tag(entry, 'title');
  if (!title) return null;
  const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => {
    const parts = clean(m[1]).split(' ');
    const family = parts.pop() ?? '';
    return { family, given: parts.join(' ') || undefined };
  });
  const published = tag(entry, 'published');
  const summary = tag(entry, 'summary');
  return {
    title: clean(title),
    authors,
    year: published ? parseInt(published.slice(0, 4), 10) : null,
    journal: 'arXiv',
    volume: null,
    issue: null,
    pages: null,
    abstract: summary ? clean(summary) : null,
  };
}
