import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getBlocks, getPaper } from '../src/server/db';
import { activeJob, type JobRow } from '../src/server/jobs';
import { extractBlocks, type ExtractionResult } from '../src/server/pdf/extract';
import { LAYOUT_VERSION, type Block } from '../src/server/pdf/layout';
import { ensureCurrentLayout } from '../src/server/tasks/import';
import type * as Config from '../src/server/config';

vi.mock('../src/server/config', async (importOriginal) => {
  const original = await importOriginal<typeof Config>();
  return { ...original, PATHS: { ...original.PATHS, db: ':memory:' } };
});
vi.mock('../src/server/pdf/extract', () => ({ extractBlocks: vi.fn() }));
vi.mock('../src/server/jobs', () => ({ activeJob: vi.fn(), startJob: vi.fn() }));

const paperId = 'legacy-layout';
const timestamp = '2025-01-01T00:00:00.000Z';

function block(idx: number, text: string, page = 1): Block {
  return { idx, page, text, lines: [[10, idx * 20, 300, idx * 20 + 12]], pageW: 612, pageH: 792,
    kind: 'body', isRef: false, spans: [[page, idx, 0, text.length]] };
}

function legacyPaper(blocks: Block[], translated = true): void {
  db.prepare('INSERT INTO papers(id,title,pdf_file,page_count,layout_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(paperId, 'Legacy paper', `${paperId}.pdf`, 2, 2, timestamp, timestamp);
  for (const b of blocks) {
    db.prepare('INSERT INTO blocks(paper_id,idx,page,text,lines,page_w,page_h,is_ref,kind,spans) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(paperId, b.idx, b.page, b.text, JSON.stringify(b.lines), b.pageW, b.pageH, 0, b.kind, '[]');
    if (translated) {
      db.prepare('INSERT INTO translations(paper_id,block_idx,ko,sentences,made_by) VALUES(?,?,?,?,?)')
        .run(paperId, b.idx, `기존 번역 ${b.idx}`, b.idx === 7 ? '[[0,5,"기존 문장"]]' : null,
          b.idx === 7 ? '{"engine":"claude","model":"saved-model"}' : null);
    }
  }
}

beforeEach(() => {
  db.prepare('DELETE FROM papers').run();
  vi.mocked(extractBlocks).mockReset();
  vi.mocked(activeJob).mockReset();
  vi.mocked(activeJob).mockReturnValue(null);
});

describe('legacy translated PDF span upgrade', () => {
  it('preserves block identities, text, translations, provenance and annotations while adding exact spans', async () => {
    const source = [block(7, 'First sentence. Next sentence.'), block(19, 'Other page.', 2)];
    legacyPaper(source);
    db.prepare('INSERT INTO highlights(id,paper_id,type,color,position,text,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('saved-highlight', paperId, 'text', 'yellow', '{"pageNumber":1}', 'First sentence.', 'My annotation', timestamp, timestamp);
    const before = getBlocks(paperId);
    const paperBefore = getPaper(paperId)!;
    const translationsBefore = db.prepare('SELECT * FROM translations').all();
    const highlightsBefore = db.prepare('SELECT * FROM highlights').all();
    // Changed extraction indices must not replace the stored translation/block keys.
    vi.mocked(extractBlocks).mockResolvedValue({ pageCount: 2, title: null,
      blocks: source.map((b, idx) => ({ ...b, idx })) });

    await ensureCurrentLayout(paperId);

    expect(getBlocks(paperId)).toEqual(before.map((b, i) => ({ ...b, spans: JSON.stringify(source[i].spans) })));
    expect(getPaper(paperId)).toEqual({ ...paperBefore, layout_version: LAYOUT_VERSION });
    expect(db.prepare('SELECT * FROM translations').all()).toEqual(translationsBefore);
    expect(db.prepare('SELECT * FROM highlights').all()).toEqual(highlightsBefore);
    await ensureCurrentLayout(paperId);
    expect(extractBlocks).toHaveBeenCalledTimes(1);
  });

  it('does not assign spans to changed text, another page or ambiguous repeated text', async () => {
    const source = [block(2, 'Changed text.'), block(3, 'Wrong page.'), block(4, 'Repeated.'), block(5, 'Repeated.')];
    legacyPaper(source);
    const repeated = block(8, 'Repeated.');
    vi.mocked(extractBlocks).mockResolvedValue({ pageCount: 2, title: null, blocks: [
      block(2, 'Changed text!'), block(3, 'Wrong page.', 2), repeated, { ...repeated, idx: 9 },
    ] });

    await ensureCurrentLayout(paperId);

    expect(getBlocks(paperId).map((b) => b.spans)).toEqual(['[]', '[]', '[]', '[]']);
    expect(getPaper(paperId)?.layout_version).toBe(LAYOUT_VERSION);
    await ensureCurrentLayout(paperId);
    expect(extractBlocks).toHaveBeenCalledTimes(1);
  });

  it('uses both exact identity and geometry for repeated text, not a coincidental index', async () => {
    const source = [block(4, 'Repeated.'), block(5, 'Repeated.'), block(6, 'Repeated.')];
    legacyPaper(source);
    vi.mocked(extractBlocks).mockResolvedValue({ pageCount: 1, title: null, blocks: [
      source[0], { ...source[1], lines: [[10, 900, 300, 912]] },
      { ...source[2], idx: 9 },
    ] });

    await ensureCurrentLayout(paperId);

    expect(getBlocks(paperId).map((b) => b.spans)).toEqual([JSON.stringify(source[0].spans), '[]', '[]']);
  });

  it('does not reuse one extracted paragraph for two stored copies', async () => {
    const source = [block(4, 'Repeated.'), block(5, 'Repeated.')];
    legacyPaper(source);
    vi.mocked(extractBlocks).mockResolvedValue({ pageCount: 1, title: null, blocks: [source[0]] });

    await ensureCurrentLayout(paperId);

    expect(getBlocks(paperId).map((b) => b.spans)).toEqual([JSON.stringify(source[0].spans), '[]']);
  });
});

describe('layout rebuild and job guards', () => {
  it.each([false, true])('retains the full cutover for untranslated or forced papers (force=%s)', async (force) => {
    legacyPaper([block(7, 'Old text.')], force);
    const replacement = block(0, 'New text.', 2);
    vi.mocked(extractBlocks).mockResolvedValue({ pageCount: 3, title: null, blocks: [replacement] });

    await ensureCurrentLayout(paperId, { force });

    expect(getBlocks(paperId)).toEqual([{ paper_id: paperId, idx: 0, page: 2, text: replacement.text,
      lines: JSON.stringify(replacement.lines), page_w: 612, page_h: 792, is_ref: 0, kind: 'body',
      spans: JSON.stringify(replacement.spans) }]);
    expect(db.prepare('SELECT * FROM translations').all()).toEqual([]);
    expect(getPaper(paperId)?.page_count).toBe(3);
    expect(getPaper(paperId)?.layout_version).toBe(LAYOUT_VERSION);
  });

  it.each(['import', 'translation'] as const)('does not start extraction during an active %s job', async (kind) => {
    legacyPaper([block(7, 'Old text.')]);
    vi.mocked(activeJob).mockImplementation((_paperId, queried) => queried === kind ? {} as JobRow : null);

    await ensureCurrentLayout(paperId);

    expect(extractBlocks).not.toHaveBeenCalled();
    expect(getPaper(paperId)?.layout_version).toBe(2);
  });

  it.each([
    { kind: 'import' as const, force: false }, { kind: 'translation' as const, force: false },
    { kind: 'import' as const, force: true }, { kind: 'translation' as const, force: true },
  ])('does not commit when $kind starts during extraction (force=$force)', async ({ kind, force }) => {
    legacyPaper([block(7, 'Old text.')]);
    const before = getBlocks(paperId);
    const translationsBefore = db.prepare('SELECT * FROM translations').all();
    const { promise, resolve } = Promise.withResolvers<ExtractionResult>();
    vi.mocked(extractBlocks).mockReturnValue(promise);
    const pending = ensureCurrentLayout(paperId, { force });
    expect(ensureCurrentLayout(paperId, { force })).toBe(pending);
    vi.mocked(activeJob).mockImplementation((_paperId, queried) => queried === kind ? {} as JobRow : null);
    resolve({ pageCount: 1, title: null, blocks: [block(0, 'Replacement.')] });

    await pending;

    expect(getBlocks(paperId)).toEqual(before);
    expect(db.prepare('SELECT * FROM translations').all()).toEqual(translationsBefore);
    expect(getPaper(paperId)?.layout_version).toBe(2);
    vi.mocked(activeJob).mockReturnValue(null);
    vi.mocked(extractBlocks).mockResolvedValue({ pageCount: 1, title: null, blocks: [block(7, 'Old text.')] });
    await ensureCurrentLayout(paperId, { force });
    expect(getPaper(paperId)?.layout_version).toBe(LAYOUT_VERSION);
  });

  it('rechecks translations created while an untranslated paper is being extracted', async () => {
    const source = block(7, 'Old text.');
    legacyPaper([source], false);
    const { promise, resolve } = Promise.withResolvers<ExtractionResult>();
    vi.mocked(extractBlocks).mockReturnValue(promise);
    const pending = ensureCurrentLayout(paperId);
    db.prepare('INSERT INTO translations(paper_id,block_idx,ko) VALUES(?,?,?)').run(paperId, 7, '새로 저장한 번역');
    resolve({ pageCount: 1, title: null, blocks: [{ ...source, idx: 0 }] });

    await pending;

    expect(getBlocks(paperId).map((b) => b.idx)).toEqual([7]);
    expect(db.prepare('SELECT ko FROM translations').get()).toEqual({ ko: '새로 저장한 번역' });
    expect(getBlocks(paperId)[0].spans).toBe(JSON.stringify(source.spans));
  });

  it('keeps data and retries on a later open after extraction fails', async () => {
    const source = block(7, 'Old text.');
    legacyPaper([source]);
    const before = getBlocks(paperId);
    vi.mocked(extractBlocks).mockRejectedValueOnce(new Error('Unreadable PDF'))
      .mockResolvedValueOnce({ pageCount: 1, title: null, blocks: [source] });

    await ensureCurrentLayout(paperId);

    expect(getBlocks(paperId)).toEqual(before);
    expect(getPaper(paperId)?.layout_version).toBe(2);
    await ensureCurrentLayout(paperId);
    expect(getBlocks(paperId)[0].spans).toBe(JSON.stringify(source.spans));
    expect(extractBlocks).toHaveBeenCalledTimes(2);
  });
});
