import type { LlmResult } from '../src/server/llm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPARISON_DIMENSIONS, buildComparisonSources, comparisonMarkdown, comparisonSourceHref, locateComparisonSource, parseComparisonResult, selectComparisonBlocks, validateComparisonGeneration, type ComparisonInputPaper, type ComparisonResult } from '../src/shared/comparison';
import { parsePageHref } from '../src/shared/cite';

// Isolated SQLite and no real CLI, config, user directories, PDF files, credentials or Drive calls.
vi.mock('../src/server/config', () => ({ PATHS: { db: ':memory:', pdfs: '/nonexistent-comparison-test-pdfs', images: '/nonexistent-comparison-test-images' } }));
vi.mock('../src/server/llm', () => ({ runLlm: vi.fn(), resolveModel: vi.fn(() => ({ engine: 'codex', model: 'test-heavy', effort: 'high' })) }));
import { db, getArtifact } from '../src/server/db';
import { HttpError } from '../src/server/http-error';
import { cancelJob, getJobRow, subscribeJob, type JobRow } from '../src/server/jobs';
import { runLlm } from '../src/server/llm';
import { comparisonRoutes } from '../src/server/routes/comparison';
import { applyRow, readPaperRows } from '../src/server/sync/rows';
import '../src/server/sync/state';
import { listComparisons, readComparison, saveComparison, startComparison } from '../src/server/tasks/comparison';

const app = new Hono();
app.onError((error, c) => c.json({ error: error.message }, error instanceof HttpError ? error.status : 500));
app.route('/api', comparisonRoutes);
const by = { engine: 'codex' as const, model: 'test-heavy', effort: 'high' };
const quote = 'The calibrated sensor measured noise at 10 kelvin in the experiment.';
const inputs: ComparisonInputPaper[] = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, blocks: [{ idx: i, page: i + 1, text: `Methods. ${quote} Final sentence.`, isRef: false }] }));
function generation(ids = ['a', 'b']) {
  const sources = ids.map((paperId) => ({ paperId, page: inputs.find((p) => p.id === paperId)!.blocks[0].page, quote }));
  return { sections: COMPARISON_DIMENSIONS.map((dimension) => ({ dimension, papers: ids.map((paperId, i) => ({ paperId, claim: { text: 'The measurement used 10 kelvin.', unavailable: false, sources: [sources[i]] } })), synthesis: { text: 'The papers use the same temperature.', unavailable: false, sources: sources.slice(0, 2) } })) };
}
function result(id = 'saved'): ComparisonResult {
  return { version: 1, id, createdAt: '2026-11-03T12:00:00.000Z', by, papers: inputs.slice(0, 2).map((p) => ({ id: p.id, title: `Paper ${p.id}`, sampledBlocks: 1, totalBlocks: 1 })), sections: validateComparisonGeneration(generation(), inputs.slice(0, 2)) };
}
function finishJob(id: string): Promise<JobRow> {
  const row = getJobRow(id)!;
  if (row.status === 'done' || row.status === 'error') return Promise.resolve(row);
  const finished = Promise.withResolvers<JobRow>();
  subscribeJob(id, (event) => { if (event.event === 'done' || event.event === 'error') finished.resolve(getJobRow(id)!); });
  return finished.promise;
}
beforeEach(() => {
  db.exec('DELETE FROM jobs; DELETE FROM papers; DELETE FROM sync_alias; DELETE FROM sync_rows; DELETE FROM sync_file_hashes');
  for (const p of inputs) {
    db.prepare('INSERT INTO papers(id,title,pdf_file,created_at,updated_at) VALUES(?,?,?,?,?)').run(p.id, `Paper ${p.id}`, `${p.id}.pdf`, '2026-11-03', '2026-11-03');
    const b = p.blocks[0];
    db.prepare('INSERT INTO blocks(paper_id,idx,page,text,lines,page_w,page_h) VALUES(?,?,?,?,?,?,?)').run(p.id, b.idx, b.page, b.text, '[]', 600, 800);
  }
  vi.mocked(runLlm).mockReset().mockResolvedValue({ text: JSON.stringify(generation()), by });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('comparison selection and PDF evidence', () => {
  it.each([2, 4])('accepts the %i-paper boundary with complete original-page evidence', async (count) => {
    const ids = inputs.slice(0, count).map((p) => p.id);
    vi.mocked(runLlm).mockResolvedValue({ text: JSON.stringify(generation(ids)), by });
    const response = await app.request('/api/comparisons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paperIds: ids }) });
    expect(response.status).toBe(202);
    const started = await response.json() as { jobId: string; comparisonId: string };
    expect((await finishJob(started.jobId)).status).toBe('done');
    expect(readComparison(started.comparisonId).papers).toHaveLength(count);
  });
  it.each([[], ['a'], ['a', 'b', 'c', 'd', 'e'], ['a', 'a'], ['a', ' ']].map((paperIds) => ({ paperIds })))('rejects invalid bounds, empty IDs and duplicates: $paperIds', async ({ paperIds }) => {
    const response = await app.request('/api/comparisons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paperIds }) });
    expect(response.status).toBe(400);
    expect(runLlm).not.toHaveBeenCalled();
  });
  it('rejects missing papers and papers without actual PDF body before starting work', () => {
    expect(() => startComparison(['a', 'missing'])).toThrow('찾을 수 없습니다');
    db.prepare("UPDATE papers SET pdf_file=NULL WHERE id='b'").run();
    expect(() => startComparison(['a', 'b'])).toThrow('PDF 원문');
    db.prepare("UPDATE papers SET pdf_file='b.pdf' WHERE id='b'").run();
    db.prepare("DELETE FROM blocks WHERE paper_id='b'").run();
    expect(() => startComparison(['a', 'b'])).toThrow('PDF 원문');
    expect(runLlm).not.toHaveBeenCalled();
  });
  it('requires the entire quote on the exact paper and page, not references or approximate evidence', () => {
    expect(locateComparisonSource({ paperId: 'a', page: 1, quote }, inputs)).toEqual({ paperId: 'a', page: 1, quote, blockIdx: 0, start: 9, end: 9 + quote.length });
    for (const source of [{ paperId: 'a', page: 2, quote }, { paperId: 'b', page: 1, quote }, { paperId: 'a', page: 1, quote: quote.replace('10', '20') }, { paperId: 'a', page: 1, quote: quote + ' Invented.' }, { paperId: 'missing', page: 1, quote }]) expect(() => locateComparisonSource(source, inputs)).toThrow();
    expect(() => locateComparisonSource({ paperId: 'a', page: 1, quote }, [{ id: 'a', blocks: [{ ...inputs[0].blocks[0], isRef: true }] }])).toThrow();
  });
  it('resolves source IDs to exact PDF offsets without permitting missing IDs, cross-paper evidence or invented numbers', () => {
    const sources = buildComparisonSources(inputs.slice(0, 2));
    const papers = inputs.slice(0, 2).map((paper) => ({ ...paper, sources: sources.filter((s) => s.paperId === paper.id) }));
    const first = sources[0];
    const located = locateComparisonSource({ sourceId: first.sourceId }, papers);
    expect(papers[0].blocks[0].text.slice(located.start, located.end)).toBe(first.quote);
    expect(located).toMatchObject({ paperId: 'a', page: 1, blockIdx: 0 });
    expect(() => locateComparisonSource({ sourceId: 'invented-source' }, papers)).toThrow();
    const generated = { sections: generation().sections.map((section) => ({
      ...section,
      papers: section.papers.map((cell) => ({ ...cell, claim: { ...cell.claim, sources: [{ sourceId: sources.find((s) => s.paperId === cell.paperId)!.sourceId }] } })),
      synthesis: { ...section.synthesis, sources: sources.map((s) => ({ sourceId: s.sourceId })) },
    })) };
    expect(validateComparisonGeneration(generated, papers)[0].papers[0].claim.sources[0].quote).toBe(first.quote);
    generated.sections[0].papers[0].claim.sources = [{ sourceId: sources[1].sourceId }];
    expect(() => validateComparisonGeneration(generated, papers)).toThrow('다른 논문');
    generated.sections[0].papers[0].claim.sources = [{ sourceId: first.sourceId }];
    generated.sections[0].papers[0].claim.text = 'Measured 200 kelvin.';
    expect(() => validateComparisonGeneration(generated, papers)).toThrow('수치');
  });
  it('rejects unsupported numbers, missing cells, cross-paper cell evidence and one-paper synthesis', () => {
    const unsupported = generation(); unsupported.sections[0].papers[0].claim.text = 'There were 200 participants.';
    expect(() => validateComparisonGeneration(unsupported, inputs.slice(0, 2))).toThrow('수치');
    const missing = generation(); missing.sections[0].papers.pop();
    expect(() => validateComparisonGeneration(missing, inputs.slice(0, 2))).toThrow();
    const wrongPaper = generation(); wrongPaper.sections[0].papers[0].claim.sources = wrongPaper.sections[0].papers[1].claim.sources;
    expect(() => validateComparisonGeneration(wrongPaper, inputs.slice(0, 2))).toThrow('다른 논문');
    const synthesis = generation(); synthesis.sections[0].synthesis.sources.pop();
    expect(() => validateComparisonGeneration(synthesis, inputs.slice(0, 2))).toThrow('두 논문');
  });
  it('records unknown dimensions honestly with no fabricated reference', () => {
    const raw = generation();
    raw.sections[4].papers[0].claim = { text: '제공된 발췌에서 한계를 확인할 수 없습니다.', unavailable: true, sources: [] };
    expect(validateComparisonGeneration(raw, inputs.slice(0, 2))[4].papers[0].claim.sources).toEqual([]);
  });
  it('bounds PDF context and never sources references or AI artifacts', async () => {
    const blocks = Array.from({ length: 100 }, (_, idx) => ({ idx, page: idx + 1, text: `Results ${idx}. ` + 'Actual PDF body words. '.repeat(200), isRef: false }));
    const selected = selectComparisonBlocks([...blocks, { idx: 100, page: 101, text: 'Bibliography '.repeat(100), isRef: true }]);
    expect(selected.reduce((sum, b) => sum + b.text.length, 0)).toBeLessThanOrEqual(24000);
    expect(selected.some((b) => b.idx === 0)).toBe(true);
    expect(selected.some((b) => b.idx === 99)).toBe(true);
    expect(selected.every((b) => !b.isRef && blocks[b.idx].text.startsWith(b.text))).toBe(true);
    db.prepare("INSERT INTO artifacts(paper_id,kind,content,updated_at) VALUES('a','summary','UNTRUSTED AI SUMMARY','2026-11-03')").run();
    const started = startComparison(['a', 'b']); await finishJob(started.jobId);
    const request = vi.mocked(runLlm).mock.calls[0][0];
    expect(request.profile).toBe('heavy'); expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.prompt).not.toContain('UNTRUSTED AI SUMMARY'); expect(request.prompt).toContain(quote);
  });
});

describe('comparison jobs, persistence, export and sync', () => {
  it('saves immutable replicas, lists once, exports original paper/page/quote links, and survives one source deletion', async () => {
    const started = startComparison(['a', 'b']);
    expect(getJobRow(started.jobId)!.paper_id).toBeNull();
    expect((await finishJob(started.jobId)).status).toBe('done');
    const saved = readComparison(started.comparisonId);
    expect(saved.by).toEqual(by);
    expect(parseComparisonResult(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    expect(getArtifact('a', `comparison:${saved.id}`)?.content).toBe(getArtifact('b', `comparison:${saved.id}`)?.content);
    expect(listComparisons()).toHaveLength(1);
    const source = saved.sections[0].papers[0].claim.sources[0];
    const href = comparisonSourceHref(source);
    expect(href).toContain('/paper/a#p-1~');
    expect(parsePageHref(href.slice(href.indexOf('#')))).toEqual({ page: 1, endPage: null, quote });
    const response = await app.request(`/api/comparisons/${saved.id}/markdown`);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    const markdown = await response.text();
    expect(markdown).toBe(comparisonMarkdown(saved)); expect(markdown).toContain(href); expect(markdown).toContain(quote);
    db.prepare("DELETE FROM papers WHERE id='a'").run();
    expect(readComparison(saved.id).id).toBe(saved.id);
    expect(getJobRow(started.jobId)!.status).toBe('done');
  });
  it('exports and restores comparison through existing generic sync rows without referenced PDFs being present', () => {
    const saved = result(); saveComparison(saved);
    const rows = readPaperRows('a', new Map());
    const synced = rows.get('artifact')!.get('comparison:saved')!;
    expect(JSON.parse(synced.content as string)).toEqual(saved);
    expect(JSON.parse(synced.made_by as string)).toEqual(by);
    db.prepare("DELETE FROM artifacts WHERE kind='comparison:saved'").run();
    db.prepare("DELETE FROM papers WHERE id='b'").run();
    expect(applyRow('a', 'artifact', 'comparison:saved', synced, new Map(), new Map())).toBe(true);
    expect(readComparison('saved')).toEqual(saved);
  });
  it('resolves DOI sync aliases in paper-specific source links without mutating persisted source identity', () => {
    saveComparison(result());
    db.prepare("INSERT INTO sync_alias(remote_id,local_id) VALUES('a','c')").run();
    const saved = readComparison('saved');
    expect(saved.papers[0].id).toBe('c');
    expect(saved.sections[0].papers[0].claim.sources[0].paperId).toBe('c');
    expect(comparisonSourceHref(saved.sections[0].papers[0].claim.sources[0])).toContain('/paper/c#');
    expect(JSON.parse(getArtifact('a', 'comparison:saved')!.content).papers[0].id).toBe('a');
  });
  it('cancels real job context and never saves a cancelled result; a user retry creates a new job', async () => {
    vi.mocked(runLlm).mockImplementationOnce((request) => {
      const blocked = Promise.withResolvers<LlmResult>();
      request.signal!.addEventListener('abort', () => blocked.reject(new Error('cancelled')), { once: true });
      return blocked.promise;
    });
    const started = startComparison(['a', 'b']);
    expect(startComparison(['b', 'a'])).toEqual(started);
    expect(cancelJob(started.jobId)).toBe(true);
    expect((await finishJob(started.jobId)).status).toBe('error');
    expect(listComparisons()).toEqual([]);
    const retry = startComparison(['a', 'b']);
    expect(retry.jobId).not.toBe(started.jobId); expect((await finishJob(retry.jobId)).status).toBe('done');
  });
  it('reports invalid model output without partial saves or automatic retry', async () => {
    const bad = generation(); bad.sections[0].papers[0].claim.sources[0].quote = 'This citation was invented by the model.';
    vi.mocked(runLlm).mockResolvedValueOnce({ text: JSON.stringify(bad), by });
    const started = startComparison(['a', 'b']);
    expect((await finishJob(started.jobId)).status).toBe('error');
    expect(runLlm).toHaveBeenCalledTimes(1); expect(listComparisons()).toEqual([]);
  });
});
