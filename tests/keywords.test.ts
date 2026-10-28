import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { db } from '../src/server/db';
import { normalizeKeywords, replaceAutoKeywords } from '../src/server/terms';
import { terms as termsRoute } from '../src/server/routes/terms';

const entry = (term: string, definition = `${term}입니다.`) => ({ term, ko: '', definition, inPaper: '' });

it('keeps at most 15 distinct, defined keywords', () => {
  const list = normalizeKeywords([
    entry('Autoaggregation'),
    entry('autoaggregation,'),
    { term: 'MRS broth', ko: 'MRS 배지' },
    entry('x'.repeat(81)),
    'not an object',
    ...Array.from({ length: 20 }, (_, i) => entry(`Term ${i}`)),
  ]);
  expect(list).toHaveLength(15);
  expect(list[0]).toEqual(entry('Autoaggregation'));
  expect(list.filter((k) => k.term.toLowerCase() === 'autoaggregation')).toHaveLength(1);
  expect(list.some((k) => k.term === 'MRS broth' || k.term.length > 80)).toBe(false);
  expect(normalizeKeywords({ term: 'not an array' })).toEqual([]);
});

it('preserves meaningful brackets and rejects incomplete AI keywords', () => {
  const list = normalizeKeywords([
    entry('Wastewater-based epidemiology (WBE)'),
    entry('Wastewater-based epidemiology (WBE)'),
    entry('Shotgun (SG) metagenomics'),
    entry('Quantitative PCR (qPCR'),
    entry('()도('),
    entry('()도'),
    entry('++'),
    entry('T'),
  ]);
  expect(list.map(item => item.term)).toEqual([
    'Wastewater-based epidemiology (WBE)',
    'Shotgun (SG) metagenomics',
    'T',
  ]);
});

it('displays legacy auto abbreviations intact and reuses their saved lookup', async () => {
  const paperId = randomUUID();
  const autoId = randomUUID();
  const lookupId = randomUUID();
  const at = '2026-01-01T00:00:00.000Z';
  try {
    db.prepare('INSERT INTO papers(id,title,created_at,updated_at) VALUES(?,?,?,?)').run(paperId, 'Keyword fixture', at, at);
    const insert = db.prepare(
      "INSERT INTO terms(id,paper_id,term,term_key,ko,definition,in_paper,page,made_by,created_at,source) VALUES(?,?,?,?,?,?,'',NULL,NULL,?,?)",
    );
    insert.run(autoId, paperId, 'Wastewater-based epidemiology (WBE', 'wastewater-based epidemiology (wbe', '하수 기반 역학(WBE)', '설명', at, 'auto');
    insert.run(lookupId, paperId, 'User term (draft', 'user term (draft', '직접 찾은 용어', '설명', at, 'lookup');

    const response = await termsRoute.request(`/papers/${paperId}/terms`);
    const entries = await response.json() as { id: string; term: string }[];
    expect(entries.map(({ id, term }) => ({ id, term }))).toEqual([
      { id: autoId, term: 'Wastewater-based epidemiology (WBE)' },
      { id: lookupId, term: 'User term (draft' },
    ]);
    const existing = await termsRoute.request(`/papers/${paperId}/terms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: 'Wastewater-based epidemiology (WBE)' }),
    });
    expect((await existing.json() as { id: string }).id).toBe(autoId);
    const saved = db.prepare('SELECT term, term_key FROM terms WHERE id=?').get(autoId);
    expect(saved).toMatchObject({ term: 'Wastewater-based epidemiology (WBE', term_key: 'wastewater-based epidemiology (wbe' });
  } finally {
    db.prepare('DELETE FROM papers WHERE id=?').run(paperId);
  }
});

it('replaces earlier AI keywords but never a term the reader looked up', () => {
  const paperId = randomUUID();
  const at = '2026-01-01T00:00:00.000Z';
  const by = { engine: 'codex' as const, model: 'test-model', effort: 'low' };
  const rows = () =>
    db.prepare('SELECT term, term_key, ko, definition, source, made_by FROM terms WHERE paper_id=? ORDER BY term_key').all(paperId) as {
      term: string;
      term_key: string;
      ko: string;
      definition: string;
      source: string;
      made_by: string | null;
    }[];
  try {
    db.prepare('INSERT INTO papers(id,title,created_at,updated_at) VALUES(?,?,?,?)').run(paperId, 'Keyword fixture', at, at);
    db.prepare(
      "INSERT INTO terms(id,paper_id,term,term_key,ko,definition,in_paper,page,made_by,created_at,source) VALUES(?,?,?,?,?,?,'',3,NULL,?,'lookup')",
    ).run(randomUUID(), paperId, 'Bile salt', 'bile salt', '담즙산염', '직접 찾은 설명입니다.', at);

    replaceAutoKeywords(paperId, [entry('Probiotic'), entry('Old term')], by);
    replaceAutoKeywords(paperId, [entry('Probiotic', '새 설명입니다.'), entry('bile salt', 'AI 설명입니다.')], by);

    expect(rows()).toEqual([
      { term: 'Bile salt', term_key: 'bile salt', ko: '담즙산염', definition: '직접 찾은 설명입니다.', source: 'lookup', made_by: null },
      { term: 'Probiotic', term_key: 'probiotic', ko: 'Probiotic', definition: '새 설명입니다.', source: 'auto', made_by: JSON.stringify(by) },
    ]);
  } finally {
    db.prepare('DELETE FROM papers WHERE id=?').run(paperId);
  }
});
