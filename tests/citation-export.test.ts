import { expect, it } from 'vitest';
import { bibtexText, citationKey, libraryBibtex, libraryRis, type CitationPaper } from '../src/server/export/citations';

function row(overrides: Partial<CitationPaper['paper']> = {}, authors: CitationPaper['authors'] = []): CitationPaper {
  return {
    authors,
    paper: {
      id: 'paper-1', title: 'A Study', authors: JSON.stringify(authors), year: null,
      journal: null, volume: null, issue: null, pages: null, doi: null, arxiv_id: null,
      openalex_id: null, pmid: null, pmcid: null, abstract: null, pdf_file: null,
      page_count: null, field: null, field_suggested: null, layout_version: 1,
      created_at: '2026-01-01', updated_at: '2026-01-01', last_opened_at: null,
      starred: 0, read_status: 'unread',
      ...overrides,
    },
  };
}

it('escapes literal TeX special characters without escaping newly emitted commands', () => {
  expect(bibtexText('a\\b {x} $ & # % _ ^ ~\r\nnext')).toBe('a\\textbackslash{}b \\{x\\} \\$ \\& \\# \\% \\_ \\textasciicircum{} \\textasciitilde{} next');
});

it('exports real journal fields with protected compound, Unicode and literal author names', () => {
  const paper = row({ title: 'DNA & {RNA}', year: 2025, journal: 'Nature & Science', volume: '12', issue: '2', pages: 'S1–S9', doi: '10.1/a_b', abstract: 'A\nB' }, [
    { family: 'de la Cruz', given: 'Ana María' }, { family: '홍', given: '길동' }, { family: 'Research and Development, Inc.' },
  ]);
  const bib = libraryBibtex([paper]);
  expect(bib).toContain('@article{');
  expect(bib).toContain('title = {{DNA \\& \\{RNA\\}}}');
  expect(bib).toContain('author = {{de la Cruz}, {Ana María} and {홍}, {길동} and {Research and Development, Inc.}}');
  expect(bib).toContain('journal = {Nature \\& Science}');
  expect(bib).toContain('number = {2}');
  expect(bib).toContain('doi = {10.1/a\\_b}');
  const ris = libraryRis([paper]);
  expect(ris).toContain('TY  - JOUR\r\n');
  expect(ris).toContain('AU  - de la Cruz, Ana María\r\nAU  - 홍, 길동\r\nAU  - Research and Development, Inc.');
  expect(ris).toContain('SP  - S1\r\nEP  - S9');
  expect(ris).toContain('AB  - A B');
});

it('distinguishes arXiv preprints from published articles retaining their arXiv identifiers', () => {
  for (const journal of [null, 'arXiv', 'arXiv preprint arXiv:2601.12345']) {
    const preprint = row({ arxiv_id: '2601.12345v2', journal });
    expect(libraryBibtex([preprint])).toContain('@misc{');
    expect(libraryBibtex([preprint])).toContain('archivePrefix = {arXiv}');
    expect(libraryBibtex([preprint])).not.toContain('journal =');
    expect(libraryRis([preprint])).toContain('TY  - UNPB');
    expect(libraryRis([preprint])).toContain('UR  - https://arxiv.org/abs/2601.12345v2');
  }
  const unidentified = row({ journal: 'arXiv preprint' });
  expect(libraryBibtex([unidentified])).toContain('@misc{');
  expect(libraryBibtex([unidentified])).not.toContain('eprint =');
  expect(libraryRis([unidentified])).toContain('TY  - UNPB');
  expect(libraryRis([unidentified])).not.toContain('UR  -');
  const published = row({ journal: 'Physical Review', arxiv_id: 'hep-th/9901001' });
  expect(libraryBibtex([published])).toContain('@article{');
  expect(libraryBibtex([published])).toContain('journal = {Physical Review}');
  expect(libraryRis([published])).toContain('TY  - JOUR');
  expect(libraryRis([published])).toContain('https://arxiv.org/abs/hep-th/9901001');
});

it('omits unknown metadata without inventing dates, authors, publishers or publication status', () => {
  const paper = row();
  const bib = libraryBibtex([paper]);
  expect(bib).toBe(`@misc{${citationKey(paper)},\n  title = {{A Study}},\n}\n`);
  expect(libraryRis([paper])).toBe(`TY  - GEN\r\nID  - ${citationKey(paper)}\r\nTI  - A Study\r\nER  -\r\n`);
  expect(libraryBibtex([])).toBe('');
  expect(libraryRis([])).toBe('');
});

it('assigns unique ASCII keys to duplicate/Unicode names and keeps keys stable across scope and order', () => {
  const rows = [
    row({ id: 'a', year: 2026 }, [{ family: '홍' }]),
    row({ id: 'á', year: 2026 }, [{ family: '홍' }]),
    row({ id: 'b', year: 2026 }, [{ family: 'García' }]),
    row({ id: 'c', year: 2026 }, [{ family: 'Garcia' }]),
    row({ id: 'd', year: 2026 }, []),
  ];
  const keys = rows.map(citationKey);
  expect(new Set(keys).size).toBe(rows.length);
  expect(keys.every((key) => /^[A-Za-z0-9-]+$/.test(key))).toBe(true);
  const reversed = libraryBibtex([...rows].reverse());
  for (const paper of rows) {
    expect(libraryBibtex([paper])).toContain(`{${citationKey(paper)},`);
    expect(reversed).toContain(`{${citationKey(paper)},`);
  }
  expect(reversed.indexOf(keys[4]!)).toBeLessThan(reversed.indexOf(keys[0]!));
});

it('prevents metadata from injecting RIS records and preserves non-range page labels', () => {
  const paper = row({ title: 'Title\r\nER  -\r\nTY  - BOOK\u0000', pages: 'e01234', abstract: 'One\rTwo\nThree' }, [{ family: 'Name\nAU  - Evil' }]);
  const ris = libraryRis([paper]);
  expect(ris.split('\r\n').filter((line) => line.startsWith('TY  -'))).toHaveLength(1);
  expect(ris.split('\r\n').filter((line) => line.startsWith('ER  -'))).toHaveLength(1);
  expect(ris.split('\r\n').filter((line) => line.startsWith('AU  -'))).toHaveLength(1);
  expect(ris).toContain('SP  - e01234');
  expect(ris).not.toContain('EP  -');
  expect(ris).toContain('AB  - One Two Three');
});
