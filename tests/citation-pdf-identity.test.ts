import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type * as Config from '../src/server/config';
import type * as OpenAlex from '../src/server/services/openalex';
import type { JobCtx } from '../src/server/jobs';
import type { ExtractionResult } from '../src/server/pdf/extract';

vi.mock('../src/server/config', async (importOriginal) => {
  const original = await importOriginal<typeof Config>();
  // Vitest hoists this factory ahead of ordinary static imports.
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'paperlens-pdf-test-'));
  const tmp = join(root, 'tmp');
  const pdfs = join(root, 'pdfs');
  mkdirSync(tmp);
  mkdirSync(pdfs);
  return { ...original, PATHS: { ...original.PATHS, db: ':memory:', tmp, pdfs } };
});
vi.mock('../src/server/jobs', () => ({ activeJob: vi.fn(() => null), startJob: vi.fn(() => 'job') }));
vi.mock('../src/server/pdf/extract', () => ({ extractBlocks: vi.fn() }));
vi.mock('../src/server/services/http', () => ({ getBuffer: vi.fn(), getJson: vi.fn(), getText: vi.fn() }));
vi.mock('../src/server/services/unpaywall', () => ({ oaPdf: vi.fn(async () => null) }));
vi.mock('../src/server/services/openalex', async (importOriginal) => ({
  ...await importOriginal<typeof OpenAlex>(), getById: vi.fn(), getByDoi: vi.fn(), search: vi.fn(),
}));

import { PATHS } from '../src/server/config';
import { db, getPaper, putArtifact } from '../src/server/db';
import { startJob } from '../src/server/jobs';
import { extractBlocks } from '../src/server/pdf/extract';
import { getBuffer } from '../src/server/services/http';
import { getById } from '../src/server/services/openalex';
import { pdfIdentityConflict, retryPaperPdf } from '../src/server/tasks/import';
import { getRelated } from '../src/server/tasks/related';

const title = 'Attention Is All You Need';
const doi = '10.65215/2q58a426';
function result(text: string, metadataTitle: string | null = null): ExtractionResult {
  return { title: metadataTitle, pageCount: 1, blocks: [{ idx: 0, page: 1, text, lines: [], pageW: 600, pageH: 800, kind: 'body', isRef: false, spans: [] }] };
}
const wrong = result('Preprint doi: https://doi.org/10.65215/n2qv3163. Single-cell identification with quantum-enhanced nuclear magnetic resonance. ' + 'Research content. '.repeat(8));
const correct = result('Attention Is All You Need. doi: 10.48550/arxiv.1706.03762. ' + 'Research content. '.repeat(8));

afterAll(() => rmSync(dirname(PATHS.tmp), { recursive: true, force: true }));

beforeEach(() => {
  db.prepare('DELETE FROM blocks').run();
  db.prepare('DELETE FROM artifacts').run();
  db.prepare('DELETE FROM papers').run();
  db.prepare('INSERT INTO papers(id,title,doi,openalex_id,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('paper', title, doi, 'W1', '2025-01-01', '2025-01-01');
  vi.clearAllMocks();
  vi.mocked(startJob).mockReturnValue('job');
  vi.mocked(getById).mockResolvedValue({ id: 'W1', best_oa_location: { pdf_url: 'https://example.org/wrong' }, locations: [{ is_oa: true, pdf_url: 'https://example.org/right' }] });
  vi.mocked(getBuffer).mockResolvedValue(Buffer.from('%PDF test'));
});

async function runJob() {
  const call = vi.mocked(startJob).mock.calls[0];
  const ctx: JobCtx = { jobId: 'job', signal: new AbortController().signal, progress: vi.fn(), message: vi.fn(), delta: vi.fn(), setText: vi.fn(), emit: vi.fn() };
  await call[2](ctx);
  return ctx;
}

describe('cited PDF identity', () => {
  it('rejects a conflicting labelled DOI and unrelated title but preserves uncertain and versioned PDFs', () => {
    expect(pdfIdentityConflict({ title, doi }, wrong)).toBe(true);
    expect(pdfIdentityConflict({ title, doi }, correct)).toBe(false);
    expect(pdfIdentityConflict({ title, doi }, result('', null))).toBe(false);
    expect(pdfIdentityConflict({ title, doi }, result('Unrelated text '.repeat(20)))).toBe(false);
    expect(pdfIdentityConflict({ title, doi }, result('ATTENTION: Is all you need! doi: 10.1/other ' + 'Text '.repeat(40)))).toBe(false);
  });

  it('skips the wrong first PDF and attaches the next candidate using its extraction', async () => {
    vi.mocked(extractBlocks).mockResolvedValueOnce(wrong).mockResolvedValueOnce(correct);
    retryPaperPdf('paper');
    await runJob();
    expect(getBuffer).toHaveBeenCalledTimes(2);
    expect(extractBlocks).toHaveBeenCalledTimes(2);
    expect(getPaper('paper')?.pdf_file).toBe('paper.pdf');
    expect(db.prepare('SELECT text FROM blocks WHERE paper_id=?').get('paper')).toEqual({ text: correct.blocks[0].text });
  });

  it('leaves metadata intact and reports mismatches when no candidate is suitable', async () => {
    vi.mocked(getById).mockResolvedValue({ id: 'W1', best_oa_location: { pdf_url: 'https://example.org/wrong' } });
    vi.mocked(extractBlocks).mockResolvedValue(wrong);
    retryPaperPdf('paper');
    await expect(runJob()).rejects.toThrow('다른 논문으로 보이는 PDF');
    expect(getPaper('paper')?.pdf_file).toBeNull();
    expect(db.prepare('SELECT * FROM blocks WHERE paper_id=?').all('paper')).toHaveLength(0);
  });

  it('does not replace a PDF attached while a candidate was downloading', async () => {
    vi.mocked(extractBlocks).mockImplementation(async () => {
      db.prepare('UPDATE papers SET pdf_file=? WHERE id=?').run('attached.pdf', 'paper');
      return correct;
    });
    retryPaperPdf('paper');
    const ctx = await runJob();
    expect(getPaper('paper')?.pdf_file).toBe('attached.pdf');
    expect(ctx.progress).toHaveBeenCalledWith(1, '이미 PDF가 첨부되어 있습니다');
  });

  it('annotates cached DOI-free related works by OpenAlex ID', async () => {
    const work = { openalexId: 'W1', doi: null, title, year: null, venue: null, citedBy: 0, abstract: null, oaPdf: null, pmid: null, pmcid: null, keywords: [], authors: [] };
    putArtifact('paper', 'related', JSON.stringify({ fetchedAt: new Date().toISOString(), related: [work], recentCiting: [], topCiting: [], topic: null, errors: [] }), {}, null);
    const response = await getRelated(getPaper('paper')!, false);
    expect(response.related[0].inLibrary).toBe('paper');
  });
});
