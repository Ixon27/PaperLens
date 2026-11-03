import type { DatabaseSync } from 'node:sqlite';
import type { PaperRow } from './db';

export interface PaperSearchMatch {
  source: 'title' | 'authors' | 'body' | 'highlight' | 'note';
  snippet: string;
  highlightId: string | null;
  page: number | null;
}

interface SearchRow extends PaperRow {
  fts_title: string | null;
  fts_authors: string | null;
  fts_body: string | null;
  highlight_id: string | null;
  highlight_text: string | null;
  highlight_note: string | null;
  highlight_position: string | null;
}

const START = '\u0001';
const END = '\u0002';

function excerpt(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const positions = terms.map((term) => lower.indexOf(term.toLowerCase())).filter((i) => i >= 0);
  const first = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, first - 70);
  const end = Math.min(flat.length, start + 220);
  return `${start ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

function pageOf(position: string | null): number | null {
  if (!position) return null;
  try {
    const value = JSON.parse(position) as { boundingRect?: { pageNumber?: unknown } } | null;
    const page = value?.boundingRect?.pageNumber;
    return typeof page === 'number' && Number.isInteger(page) && page > 0 ? page : null;
  } catch {
    return null;
  }
}

/** Search annotation rows directly so local edits, deletions and sync never leave a stale note index. */
export function searchPapers(database: DatabaseSync, query: string): { paper: PaperRow; match: PaperSearchMatch }[] {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const match = terms.map((term) => `"${term.replace(/"/g, '""')}"*`).join(' AND ');
  const annotationWhere = terms.map(() => "(COALESCE(text, '') || ' ' || COALESCE(note, '')) LIKE ? ESCAPE '\\'").join(' AND ');
  const patterns = terms.map((term) => `%${term.replace(/[\\%_]/g, '\\$&')}%`);
  const rows = database.prepare(`
    WITH original_matches AS MATERIALIZED (
      SELECT paper_id,
        snippet(papers_fts, 1, ?, ?, '…', 32) AS fts_title,
        snippet(papers_fts, 2, ?, ?, '…', 32) AS fts_authors,
        snippet(papers_fts, 3, ?, ?, '…', 32) AS fts_body
      FROM papers_fts WHERE papers_fts MATCH ?
    ), annotation_matches AS (
      SELECT paper_id, id, text, note, position,
        ROW_NUMBER() OVER (PARTITION BY paper_id ORDER BY updated_at DESC, id) AS priority
      FROM highlights WHERE ${annotationWhere}
    )
    SELECT p.*, f.fts_title, f.fts_authors, f.fts_body,
      h.id AS highlight_id, h.text AS highlight_text, h.note AS highlight_note, h.position AS highlight_position
    FROM papers p
    LEFT JOIN original_matches f ON f.paper_id=p.id
    LEFT JOIN annotation_matches h ON h.paper_id=p.id AND h.priority=1
    WHERE f.paper_id IS NOT NULL OR h.paper_id IS NOT NULL
    ORDER BY p.last_opened_at DESC NULLS LAST, p.created_at DESC
  `).all(START, END, START, END, START, END, match, ...patterns) as unknown as SearchRow[];

  return rows.map((paper): { paper: PaperRow; match: PaperSearchMatch } => {
    if (paper.highlight_id) {
      const note = paper.highlight_note ?? '';
      const noteMatches = terms.some((term) => note.toLowerCase().includes(term.toLowerCase()));
      return {
        paper,
        match: {
          source: noteMatches ? 'note' : 'highlight',
          snippet: excerpt(noteMatches ? note : paper.highlight_text ?? '', terms),
          highlightId: paper.highlight_id,
          page: pageOf(paper.highlight_position),
        },
      };
    }
    const source = paper.fts_title?.includes(START) ? 'title' : paper.fts_authors?.includes(START) ? 'authors' : 'body';
    const marked = source === 'title' ? paper.fts_title : source === 'authors' ? paper.fts_authors : paper.fts_body;
    return {
      paper,
      match: { source, snippet: excerpt((marked ?? '').replace(/[\u0001\u0002]/g, ''), terms), highlightId: null, page: null },
    };
  });
}
