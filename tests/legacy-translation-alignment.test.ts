import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { db } from '../src/server/db';
import { ensureTranslationSentences, pairLegacyTranslation } from '../src/server/tasks/translation-alignment';

const sourceSentences = [
  'Lcb. rhamnosus S3 demonstrated the highest potential.',
  'Limosilactobacillus sp. (S1) showed activity against C. acnes.',
  'Another Limosilactobacillus sp. (S2) was also compared.',
  'Values in Fig. 2 and Eq. 3 were 2.5 mg (p < 0.05).',
  'The results agreed with Smith et al. [19].',
  'The findings include e.g. LAB and S. aureus.',
  'The cited result was also confirmed [20].',
  'Further studies are needed.',
];
const koreanSentences = [
  'Lcb. rhamnosus S3가 가장 높은 활성을 보였습니다.',
  'Limosilactobacillus sp. (S1)는 C. acnes를 억제했습니다.',
  '다른 Limosilactobacillus sp. (S2)도 비교했습니다.',
  'Fig. 2와 Eq. 3의 값은 2.5 mg (p < 0.05)였습니다.',
  '결과는 Smith et al. [19]과 일치했습니다.',
  '여기에는 e.g. LAB와 S. aureus가 포함됩니다.',
  '인용  결과도 확인했습니다 [20].',
  '추가 연구가 필요합니다.',
];

const source = `  ${sourceSentences.join('\n')}  `;
const ko = `\t${koreanSentences.join('  \n')}  `;

describe('pairLegacyTranslation', () => {
  it('recovers eight one-to-one sentences without treating sp. (S1) as a boundary', () => {
    const pairs = pairLegacyTranslation(source, ko);
    expect(pairs).toHaveLength(8);
    expect(pairs?.map(([start, end]) => source.slice(start, end))).toEqual(sourceSentences);
    expect(pairs?.map(([, , sentence]) => sentence)).toEqual(koreanSentences);
    let offset = 0;
    for (const [i, sentence] of sourceSentences.entries()) {
      const start = source.indexOf(sentence, offset);
      expect(pairs?.[i]).toEqual([start, start + sentence.length, koreanSentences[i]]);
      offset = start + sentence.length;
    }
  });

  it('pairs a single numbered section heading', () => {
    expect(pairLegacyTranslation('2.1. Isolation of microorganisms', '2.1. 미생물 분리')).toEqual([
      [0, '2.1. Isolation of microorganisms'.length, '2.1. 미생물 분리'],
    ]);
  });

  it('rejects merged or split translations instead of inventing source ranges', () => {
    expect(pairLegacyTranslation('First sentence. Second sentence.', '하나로 합친 문장입니다.')).toBeNull();
    expect(pairLegacyTranslation('One sentence.', '둘로 나눴습니다. 다음 문장입니다.')).toBeNull();
  });

  it('rejects empty source or translated text', () => {
    expect(pairLegacyTranslation(' \n', '번역입니다.')).toBeNull();
    expect(pairLegacyTranslation('Source text.', '\t ')).toBeNull();
    expect(pairLegacyTranslation('', '')).toBeNull();
  });
});

it('repairs only missing safe sentence metadata, preserving stored translation text and provenance exactly', () => {
  const paperId = randomUUID();
  const otherPaperId = randomUUID();
  const timestamp = '2026-01-01T00:00:00.000Z';
  const insertPaper = db.prepare('INSERT INTO papers(id,title,created_at,updated_at) VALUES(?,?,?,?)');
  const insertBlock = db.prepare('INSERT INTO blocks(paper_id,idx,page,text,lines,page_w,page_h) VALUES(?,?,1,?,\'[]\',600,800)');
  const insertTranslation = db.prepare('INSERT INTO translations(paper_id,block_idx,ko,sentences,made_by) VALUES(?,?,?,?,?)');
  const select = db.prepare('SELECT * FROM translations WHERE paper_id=? ORDER BY block_idx');
  type TranslationRow = { paper_id: string; block_idx: number; ko: string; sentences: string | null; made_by: string | null };
  const provenance = '{ "engine": "claude", "model": "stored-model", "effort": "high" }';
  const existingSentences = '[[0,13,"기존에 정렬된 번역입니다."]]';
  try {
    insertPaper.run(paperId, 'Legacy sentence fixture', timestamp, timestamp);
    insertPaper.run(otherPaperId, 'Unopened paper fixture', timestamp, timestamp);
    const fixtures: Array<[string, string, string | null, string | null]> = [
      [source, ko, null, null],
      ['First sentence. Second sentence.', '첫  문장입니다.\n둘째 문장입니다.  ', null, provenance],
      ['First sentence. Second sentence.', '합친 번역입니다.', null, null],
      ['Existing text.', '기존에 정렬된 번역입니다.', existingSentences, provenance],
      ['1. Introduction', '1. 서론', null, null],
    ];
    for (const [idx, [text, translation, sentences, madeBy]] of fixtures.entries()) {
      insertBlock.run(paperId, idx, text);
      insertTranslation.run(paperId, idx, translation, sentences, madeBy);
    }
    insertBlock.run(otherPaperId, 0, source);
    insertTranslation.run(otherPaperId, 0, ko, null, provenance);
    const before = select.all(paperId) as TranslationRow[];
    const otherBefore = select.all(otherPaperId);

    ensureTranslationSentences(paperId);

    const after = select.all(paperId) as TranslationRow[];
    for (const [idx, row] of after.entries()) {
      const [text, translation] = fixtures[idx];
      const expected = idx === 3 ? existingSentences : JSON.stringify(pairLegacyTranslation(text, translation));
      expect(row).toEqual({ ...before[idx], sentences: expected === 'null' ? null : expected });
    }
    expect(JSON.parse(after[0].sentences!)).toHaveLength(8);
    expect(after[0].ko).toBe(ko);
    expect(after[0].made_by).toBeNull();
    expect(after[1].made_by).toBe(provenance);
    expect(after[2].sentences).toBeNull();
    expect(select.all(otherPaperId)).toEqual(otherBefore);

    ensureTranslationSentences(paperId);
    expect(select.all(paperId)).toEqual(after);
  } finally {
    db.prepare('DELETE FROM papers WHERE id IN (?,?)').run(paperId, otherPaperId);
  }
});
