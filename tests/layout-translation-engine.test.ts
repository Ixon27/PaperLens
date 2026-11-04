import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { LayoutTranslationDocument, LayoutTranslationPage, LayoutTranslationRegion } from '../src/shared/layout-translation';
import type { LayoutPdf } from '../src/server/pdf/layout-translation';

vi.mock('../src/server/config', () => ({ PATHS: { db: ':memory:', pdfs: '/isolated-test-pdfs', prompts: fileURLToPath(new URL('../prompts', import.meta.url)) } }));
vi.mock('../src/server/llm', () => ({ resolveModel: vi.fn(() => ({ engine: 'codex', model: 'requested', effort: 'low' })), runLlm: vi.fn() }));
vi.mock('../src/server/pdf/layout-translation', () => ({
  MAX_LAYOUT_PAGES: 2000, openLayoutPdf: vi.fn(), layoutPdfHash: vi.fn(), extractLayoutPage: vi.fn(), createLayoutOcr: vi.fn(), renderLayoutPage: vi.fn(),
  abortableLayoutWork: async <T>(work: Promise<T>, signal: AbortSignal) => { signal.throwIfAborted(); return work; },
}));
vi.mock('../src/server/routes/papers', () => ({ requirePaper: (id: string) => {
  const paper = getPaper(id);
  if (!paper) throw new HttpError(404, '논문을 찾을 수 없습니다');
  return paper;
} }));

import { db, getArtifact, getPaper, putArtifact } from '../src/server/db';
import { HttpError } from '../src/server/http-error';
import { cancelJob, getJobRow, subscribeJob, type JobRow } from '../src/server/jobs';
import { runLlm } from '../src/server/llm';
import { createLayoutOcr, extractLayoutPage, layoutPdfHash, openLayoutPdf, renderLayoutPage } from '../src/server/pdf/layout-translation';
import { layoutTranslationRoutes } from '../src/server/routes/layout-translation';
import { layoutBatches, maskLayoutSource, mergeLayoutPage, parseLayoutDocument, readLayoutTranslation, startLayoutTranslation, validateLayoutOptions, validateLayoutTranslations } from '../src/server/tasks/layout-translation';

const hash = 'a'.repeat(64);
const actualBy = { engine: 'claude' as const, model: 'actually-used', effort: 'low' };
function region(id = 'p1-pdf-0', source = 'Measured value 10'): LayoutTranslationRegion {
  return { id, source, ko: null, box: [10, 20, 80, 12], fontSize: 10, rotation: 0, origin: 'pdf', kind: 'text', confidence: 1, safe: true };
}
function page(number: number, regions = [region(`p${number}-pdf-0`)]): LayoutTranslationPage { return { page: number, width: 300, height: 400, regions, warnings: [] }; }
function document(pages: LayoutTranslationPage[]): LayoutTranslationDocument { return { version: 1, pdfHash: hash, pages, by: actualBy, updatedAt: '2026-11-03', ocr: false }; }
function finish(id: string): Promise<JobRow> {
  const row = getJobRow(id)!;
  if (row.status === 'done' || row.status === 'error') return Promise.resolve(row);
  const result = Promise.withResolvers<JobRow>();
  subscribeJob(id, (event) => { if (event.event === 'done' || event.event === 'error') result.resolve(getJobRow(id)!); });
  return result.promise;
}
const app = new Hono();
app.onError((error, c) => c.json({ error: error.message }, error instanceof HttpError ? error.status : 500));
app.route('/api', layoutTranslationRoutes);
let opened: LayoutPdf;

beforeEach(() => {
  db.exec('DELETE FROM jobs; DELETE FROM papers;');
  db.prepare('INSERT INTO papers(id,title,pdf_file,page_count,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('paper', 'Layout paper', 'paper.pdf', 3, '2026-11-03', '2026-11-03');
  const getPage = vi.fn(async (number: number) => ({ pageNumber: number, getViewport: () => ({ width: 300, height: 400 }), cleanup: vi.fn() }));
  opened = { hash, pdf: { numPages: 3, getPage }, close: vi.fn(async () => {}) } as unknown as LayoutPdf;
  vi.mocked(openLayoutPdf).mockReset().mockResolvedValue(opened);
  vi.mocked(layoutPdfHash).mockReset().mockResolvedValue(hash);
  vi.mocked(extractLayoutPage).mockReset().mockImplementation(async (pdfPage) => page(pdfPage.pageNumber));
  vi.mocked(createLayoutOcr).mockReset().mockResolvedValue({ terminate: vi.fn(async () => {}) } as never);
  vi.mocked(renderLayoutPage).mockReset().mockResolvedValue({ scale: 2, canvas: { toBuffer: () => Buffer.from([137, 80, 78, 71]) } } as never);
  vi.mocked(runLlm).mockReset().mockImplementation(async ({ prompt }) => {
    const body = JSON.parse(prompt.split('<untrusted_pdf_regions>')[1].split('</untrusted_pdf_regions>')[0]) as Record<string, { source: string }>;
    return { text: JSON.stringify(Object.fromEntries(Object.entries(body).map(([id, value]) => [id, value.source.replace('Measured value', '측정값')]))), by: actualBy };
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('layout request, response and artifact bounds', () => {
  it('deduplicates explicit pages but rejects empty, coerced, fractional and out-of-PDF pages', () => {
    expect(validateLayoutOptions({ pages: [3, 1, 3], ocr: true }, 3)).toEqual({ pages: [1, 3], ocr: true });
    expect(validateLayoutOptions({})).toEqual({ ocr: false });
    for (const pages of [[], ['1'], [0], [4], [1.5], [NaN], Array(2001).fill(1)]) expect(() => validateLayoutOptions({ pages }, 3)).toThrow();
    expect(() => validateLayoutOptions({ ocr: 'true' })).toThrow();
    expect(() => validateLayoutOptions({ extra: true })).toThrow();
  });
  it('validates IDs once, retains valid neighbors and explicitly preserves unchanged proper names', () => {
    const batch = [region('a'), region('b')];
    for (const result of [{ a: '측정값 10' }, { a: '측정값 10', b: '측정값 10', c: '추가 10' }]) expect(() => validateLayoutTranslations(JSON.stringify(result), batch)).toThrow();
    const partial = validateLayoutTranslations('{"a":"측정값 11","b":"측정값 10"}', batch);
    expect(partial.errors.has('a')).toBe(true);
    expect(partial.values.get('b')).toBe('측정값 10');
    const unchanged = validateLayoutTranslations('{"journal":"Nature Biotechnology","b":null}', [region('journal', 'Nature Biotechnology'), region('b')]);
    expect([...unchanged.preserved]).toEqual(['journal', 'b']);
    expect(unchanged.errors.size).toBe(0);
    expect(unchanged.values.get('journal')).toBeNull();
    expect(validateLayoutTranslations('{"a":"","b":"측정값 10"}', batch).errors.has('a')).toBe(true);
  });
  it('restores placeholders or accepts exact raw scientific values, never changed or malformed tokens', () => {
    const source = 'Received: 2 June 2024; measured -2.00 mV and α';
    const masked = maskLayoutSource(source);
    const batch = [region('a', source)];
    const masks = new Map([['a', masked]]);
    const valid = validateLayoutTranslations('{"a":"접수: ⟦PLT0⟧; 측정 ⟦PLT1⟧ 및 ⟦PLT2⟧"}', batch, masks);
    expect(valid.values.get('a')).toBe('접수: 2 June 2024; 측정 -2.00 mV 및 α');
    expect(validateLayoutTranslations('{"a":"접수: 2 June 2024; 측정 -2.00 mV 및 α"}', batch, masks).values.get('a')).toBe('접수: 2 June 2024; 측정 -2.00 mV 및 α');
    for (const value of ['접수: 2 June 2024; 측정 -2 mV 및 α', '접수: 2 June 2024; 측정 -2.00 V 및 α', '접수: 2 June 2024; 측정 -2.00 mV 및 ⟦PLT 2⟧']) expect(validateLayoutTranslations(JSON.stringify({ a: value }), batch, masks).errors.has('a')).toBe(true);
    for (const value of ['측정 -2.00 mV', '접수 ⟦PLT0⟧ ⟦PLT0⟧ ⟦PLT1⟧ ⟦PLT2⟧', '접수 ⟦PLT0⟧ 및 ⟦PLT1⟧']) expect(validateLayoutTranslations(JSON.stringify({ a: value }), batch, masks).errors.has('a')).toBe(true);
  });
  it('protects plural scientific identifiers from natural Korean singularization', () => {
    const source = 'Compare pDNA-LNPs and mRNA-LNPs';
    const masked = maskLayoutSource(source);
    expect(masked.source).not.toContain('pDNA-LNPs');
    expect(masked.source).not.toContain('mRNA-LNPs');
    const batch = [region('a', source)];
    const masks = new Map([['a', masked]]);
    const result = validateLayoutTranslations('{"a":"⟦PLT0⟧와 ⟦PLT1⟧를 비교합니다"}', batch, masks);
    expect(result.values.get('a')).toBe('pDNA-LNPs와 mRNA-LNPs를 비교합니다');
    expect(validateLayoutTranslations('{"a":"pDNA-LNP와 mRNA-LNP를 비교합니다"}', batch, masks).errors.has('a')).toBe(true);
  });
  it('bounds batch count/chars and excludes protected/already translated regions', () => {
    const input = Array.from({ length: 70 }, (_, i) => region(`r${i}`, 'English text '.repeat(40)));
    const batches = layoutBatches([...input, { ...region('done'), ko: '측정값 10' }, { ...region('equation'), kind: 'protected' }]);
    expect(batches.flat()).toHaveLength(70);
    for (const batch of batches) { expect(batch.length).toBeLessThanOrEqual(32); expect(batch.reduce((n, item) => n + item.source.length, 0)).toBeLessThanOrEqual(10_000); }
    expect(() => layoutBatches([region('huge', 'x'.repeat(10_001))])).toThrow();
  });
  it('rejects wrong PDF hashes, duplicate page IDs, invalid coordinates and oversized artifacts', () => {
    const value = document([page(1)]);
    expect(parseLayoutDocument(JSON.stringify(value), hash)).toEqual(value);
    expect(parseLayoutDocument(JSON.stringify(value), 'b'.repeat(64))).toBeNull();
    expect(parseLayoutDocument(JSON.stringify(document([page(1), page(1)])), hash)).toBeNull();
    expect(parseLayoutDocument(JSON.stringify(document([page(1, [{ ...region(), box: [0, 0, -1, 10] }])])), hash)).toBeNull();
    expect(parseLayoutDocument(' '.repeat(20_000_001), hash)).toBeNull();
  });
  it('merges only exact-source translations and retains prior OCR on native-only resume', () => {
    const previous = page(1, [{ ...region(), ko: '측정값 10' }, { ...region('p1-ocr-0'), origin: 'ocr', safe: false, ko: '측정값 10' }]);
    expect(mergeLayoutPage(previous, page(1), true).regions.map((item) => item.ko)).toEqual(['측정값 10', '측정값 10']);
    expect(mergeLayoutPage(previous, page(1, [{ ...region(), box: [9, 19, 82, 14] }]), false).regions[0].ko).toBe('측정값 10');
    expect(mergeLayoutPage(previous, page(1, [region('p1-pdf-0', 'Changed value 10')]), false).regions[0].ko).toBeNull();
  });
});

describe('incremental layout job and API behavior', () => {
  it('saves actual result.by and successful pages despite an omitted later batch', async () => {
    vi.mocked(runLlm).mockResolvedValueOnce({ text: '{"p1-pdf-0":"측정값 ⟦PLT0⟧"}', by: actualBy }).mockResolvedValueOnce({ text: '{}', by: actualBy }).mockResolvedValueOnce({ text: '{"p3-pdf-0":"측정값 ⟦PLT0⟧"}', by: actualBy });
    const job = await startLayoutTranslation('paper', {});
    expect((await finish(job)).status).toBe('error');
    const saved = (await readLayoutTranslation('paper'))!;
    expect(saved.by).toEqual(actualBy);
    expect(saved.pages.map((item) => item.regions[0].ko)).toEqual(['측정값 10', null, '측정값 10']);
    expect(saved.pages[1].warnings.join(' ')).toContain('ID');
    expect(getArtifact('paper', 'layoutTranslation')?.made_by).toBe(JSON.stringify(actualBy));
    expect(opened.close).toHaveBeenCalled();
    vi.mocked(runLlm).mockClear();
    expect((await finish(await startLayoutTranslation('paper', {}))).status).toBe('done');
    expect(runLlm).toHaveBeenCalledTimes(1);
    expect((await readLayoutTranslation('paper'))!.pages[1].regions[0].ko).toBe('측정값 10');
  });
  it('preserves a previously successful page and persists extraction-failure warnings', async () => {
    putArtifact('paper', 'layoutTranslation', JSON.stringify(document([page(1, [{ ...region(), ko: '측정값 10' }])])), {}, actualBy);
    vi.mocked(extractLayoutPage).mockRejectedValue(new Error('좌표 추출 실패'));
    expect((await finish(await startLayoutTranslation('paper', {}))).status).toBe('error');
    const saved = (await readLayoutTranslation('paper'))!;
    expect(saved.pages[0].regions[0].ko).toBe('측정값 10');
    expect(saved.pages[1].warnings.join(' ')).toContain('좌표 추출 실패');
    expect(runLlm).not.toHaveBeenCalled();
  });
  it('keeps an explicit untranslatable result null rather than faking Korean', async () => {
    vi.mocked(runLlm).mockResolvedValue({ text: '{"p1-pdf-0":null}', by: actualBy });
    expect((await finish(await startLayoutTranslation('paper', { pages: [1] }))).status).toBe('done');
    const saved = (await readLayoutTranslation('paper'))!;
    expect(saved.pages[0].regions[0].ko).toBeNull();
    expect(saved.pages[0].warnings.join(' ')).toContain('번역 불가');
    expect(saved.pages[0].regions[0].kind).toBe('protected');
    expect(saved.pages[0].regions[0].safe).toBe(false);
    vi.mocked(runLlm).mockClear();
    await finish(await startLayoutTranslation('paper', { pages: [1] }));
    expect(runLlm).not.toHaveBeenCalled();
  });
  it('cancels without dropping an earlier successful page', async () => {
    const pending = Promise.withResolvers<void>();
    vi.mocked(runLlm).mockResolvedValueOnce({ text: '{"p1-pdf-0":"측정값 ⟦PLT0⟧"}', by: actualBy }).mockImplementationOnce(async ({ signal }) => {
      pending.resolve();
      const aborted = Promise.withResolvers<never>();
      signal!.addEventListener('abort', () => aborted.reject(new Error('취소됨')), { once: true });
      return aborted.promise;
    });
    const job = await startLayoutTranslation('paper', {});
    await pending.promise;
    expect(cancelJob(job)).toBe(true);
    expect((await finish(job)).error).toBe('취소됨');
    expect((await readLayoutTranslation('paper'))!.pages[0].regions[0].ko).toBe('측정값 10');
  });
  it('persists a valid neighboring region when one model value corrupts a protected token', async () => {
    vi.mocked(extractLayoutPage).mockResolvedValue(page(1, [region('a'), region('b')]));
    vi.mocked(runLlm).mockResolvedValue({ text: '{"a":"측정값 ⟦PLT0⟧","b":"측정값 999"}', by: actualBy });
    expect((await finish(await startLayoutTranslation('paper', { pages: [1] }))).status).toBe('error');
    const saved = (await readLayoutTranslation('paper'))!;
    expect(saved.pages[0].regions.map((item) => item.ko)).toEqual(['측정값 10', null]);
    expect(saved.pages[0].warnings.join(' ')).toContain('유효한 번역은 저장');
  });
  it('verifies hashes before synced artifact reuse and does not delete mismatched data', async () => {
    const content = JSON.stringify(document([page(1, [{ ...region(), ko: '측정값 10' }])]));
    putArtifact('paper', 'layoutTranslation', content, {}, actualBy);
    vi.mocked(layoutPdfHash).mockResolvedValue('b'.repeat(64));
    const response = await app.request('/api/papers/paper/layout-translation');
    expect(await response.json()).toEqual({ document: null });
    expect(getArtifact('paper', 'layoutTranslation')!.content).toBe(content);
  });
  it('serves bounded original PNG pages and validates POST page bounds before starting', async () => {
    const bad = await app.request('/api/papers/paper/layout-translation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"pages":[4]}' });
    expect(bad.status).toBe(400);
    expect(runLlm).not.toHaveBeenCalled();
    const png = await app.request('/api/papers/paper/layout-translation/source/2.png');
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(renderLayoutPage).toHaveBeenCalled();
    expect((await app.request('/api/papers/paper/layout-translation/source/2.5.png')).status).toBe(400);
    expect((await app.request('/api/papers/paper/layout-translation/source/4.png')).status).toBe(400);
  });
  it('records OCR coverage per page rather than pretending all pages have OCR', async () => {
    expect((await finish(await startLayoutTranslation('paper', { pages: [1], ocr: true }))).status).toBe('done');
    expect((await readLayoutTranslation('paper'))!.ocr).toBe(true);
    expect(JSON.parse(getArtifact('paper', 'layoutTranslation')!.meta).ocrPages).toEqual([1]);
    expect(createLayoutOcr).toHaveBeenCalledTimes(1);
    await finish(await startLayoutTranslation('paper', { pages: [2], ocr: true }));
    expect(createLayoutOcr).toHaveBeenCalledTimes(2);
  });
});
