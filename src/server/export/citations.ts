import type { Author, PaperRow } from '../db';

export interface CitationPaper {
  paper: PaperRow;
  authors: Author[];
}

// Metadata is plain text, not TeX or RIS markup. Collapse line breaks so metadata
// cannot introduce RIS records, and discard non-printing controls in both formats.
function text(value: string | number | null | undefined): string {
  return String(value ?? '').replace(/[\s\u0000-\u001f\u007f-\u009f]+/gu, ' ').trim();
}

const TEX_ESCAPES: Record<string, string> = {
  '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '$': '\\$', '&': '\\&',
  '#': '\\#', '%': '\\%', '_': '\\_', '^': '\\textasciicircum{}', '~': '\\textasciitilde{}',
};

export function bibtexText(value: string | number): string {
  return text(value).replace(/[\\{}$&#%_^~]/g, (character) => TEX_ESCAPES[character]!);
}

/** ASCII keys stay usable in classic BibTeX. The encoded DB identity is injective,
 * so duplicate/Unicode author names stay unique and stable across export scopes. */
export function citationKey({ paper, authors }: CitationPaper): string {
  const family = text(authors[0]?.family).normalize('NFD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9]/g, '');
  return `${family || 'paper'}${paper.year ?? 'nd'}-${Buffer.from(paper.id, 'utf8').toString('hex')}`;
}

function isPreprint(paper: PaperRow): boolean {
  return /^arxiv\b/i.test(text(paper.journal)) || (!!text(paper.arxiv_id) && !text(paper.journal));
}

function authorName(author: Author, bibtex: boolean): string {
  const family = text(author.family);
  const given = text(author.given);
  if (!bibtex) return family && given ? `${family}, ${given}` : family || given;
  // Braced name parts protect particles, embedded commas and the literal word
  // "and". A single-part name is a literal/corporate name, not guessed initials.
  if (family && given) return `{${bibtexText(family)}}, {${bibtexText(given)}}`;
  return family || given ? `{${bibtexText(family || given)}}` : '';
}

export function libraryBibtex(rows: readonly CitationPaper[]): string {
  return rows.map((row) => {
    const p = row.paper;
    const preprint = isPreprint(p);
    const fields: string[] = [];
    const add = (key: string, value: string | number | null | undefined) => {
      if (text(value)) fields.push(`  ${key} = {${bibtexText(value!)}},`);
    };
    // An extra brace layer preserves title capitalization in bibliography styles.
    if (text(p.title)) fields.push(`  title = {{${bibtexText(p.title)}}},`);
    const authors = row.authors.map((a) => authorName(a, true)).filter(Boolean);
    if (authors.length) fields.push(`  author = {${authors.join(' and ')}},`);
    add('year', p.year);
    if (!preprint) add('journal', p.journal);
    add('volume', p.volume);
    add('number', p.issue);
    add('pages', p.pages);
    add('doi', p.doi);
    if (text(p.arxiv_id)) {
      add('archivePrefix', 'arXiv');
      add('eprint', p.arxiv_id);
      add('url', `https://arxiv.org/abs/${encodeURIComponent(text(p.arxiv_id)).replace(/%2F/gi, '/')}`);
    }
    add('abstract', p.abstract);
    return `@${!preprint && text(p.journal) ? 'article' : 'misc'}{${citationKey(row)},\n${fields.join('\n')}\n}`;
  }).join('\n\n') + (rows.length ? '\n' : '');
}

export function libraryRis(rows: readonly CitationPaper[]): string {
  return rows.map((row) => {
    const p = row.paper;
    const preprint = isPreprint(p);
    const lines = [`TY  - ${preprint ? 'UNPB' : text(p.journal) ? 'JOUR' : 'GEN'}`];
    const add = (tag: string, value: string | number | null | undefined) => {
      const clean = text(value);
      if (clean) lines.push(`${tag}  - ${clean}`);
    };
    add('ID', citationKey(row));
    add('TI', p.title);
    for (const author of row.authors) add('AU', authorName(author, false));
    add('PY', p.year);
    if (!preprint) add('JO', p.journal);
    add('VL', p.volume);
    add('IS', p.issue);
    const pages = text(p.pages).match(/^([^\s–—-]+)\s*[-–—]+\s*([^\s–—-]+)$/u);
    add('SP', pages ? pages[1] : p.pages);
    if (pages) add('EP', pages[2]);
    add('DO', p.doi);
    if (text(p.arxiv_id)) add('UR', `https://arxiv.org/abs/${encodeURIComponent(text(p.arxiv_id)).replace(/%2F/gi, '/')}`);
    add('AB', p.abstract);
    lines.push('ER  -');
    return lines.join('\r\n');
  }).join('\r\n\r\n') + (rows.length ? '\r\n' : '');
}
