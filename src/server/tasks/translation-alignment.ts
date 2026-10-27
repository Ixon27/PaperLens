import { db } from '../db';
import { splitKoreanSentences, splitSentences } from '../pdf/sentences';

/** Recover only one-to-one sentence pairs, using exact substrings of the stored translation. */
export function pairLegacyTranslation(source: string, ko: string): Array<[number, number, string]> | null {
  if (!source.trim() || !ko.trim()) return null;
  const sourceRanges = splitSentences(source);
  const koreanRanges = splitKoreanSentences(ko);
  if (sourceRanges.length !== koreanRanges.length) return null;
  return sourceRanges.map(([start, end], i) => {
    const [koStart, koEnd] = koreanRanges[i];
    return [start, end, ko.slice(koStart, koEnd)];
  });
}

/** Backfill safe legacy alignments without changing translation text or model provenance. */
export function ensureTranslationSentences(paperId: string): void {
  const rows = db.prepare(`
    SELECT t.block_idx, b.text, t.ko FROM translations t
    JOIN blocks b ON b.paper_id=t.paper_id AND b.idx=t.block_idx
    WHERE t.paper_id=? AND t.sentences IS NULL
  `).all(paperId) as Array<{ block_idx: number; text: string; ko: string }>;
  const update = db.prepare('UPDATE translations SET sentences=? WHERE paper_id=? AND block_idx=? AND sentences IS NULL');
  for (const row of rows) {
    const sentences = pairLegacyTranslation(row.text, row.ko);
    if (sentences) update.run(JSON.stringify(sentences), paperId, row.block_idx);
  }
}
