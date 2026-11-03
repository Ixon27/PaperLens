import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmResult } from '../src/server/llm';
import { parsePresentationContent, presentationEvidence, presentationMarkdown, validatePresentationDuration, validatePresentationGeneration, type PresentationBlock, type PresentationContent, type PresentationResponse } from '../src/shared/presentation';

// In-memory storage only; never create user directories or launch a model CLI.
vi.mock('../src/server/config', () => ({ PATHS: { db: ':memory:', prompts: fileURLToPath(new URL('../prompts', import.meta.url)) } }));
vi.mock('../src/server/llm', () => ({ runLlm: vi.fn(), resolveModel: vi.fn(() => ({ engine: 'codex', model: 'presentation-model', effort: 'high' })) }));
vi.mock('../src/server/routes/papers', () => ({ requirePaper: (id: string) => {
  const paper = getPaper(id);
  if (!paper) throw new HttpError(404, '논문을 찾을 수 없습니다');
  return paper;
} }));

import { db, getArtifact, getPaper, putArtifact } from '../src/server/db';
import { HttpError } from '../src/server/http-error';
import { cancelJob, getJobRow, subscribeJob, type JobRow } from '../src/server/jobs';
import { runLlm } from '../src/server/llm';
import { presentationRoutes } from '../src/server/routes/presentation';
import { presentationAnalysis, readPresentation, startPresentation } from '../src/server/tasks/presentation';

const app = new Hono();
app.onError((error, c) => c.json({ error: error.message }, error instanceof HttpError ? error.status : 500));
app.route('/api', presentationRoutes);
const by = { engine: 'codex' as const, model: 'presentation-model', effort: 'high' };
const quote = 'The calibrated sensor measured resonator noise at 10 kelvin in three independent experiments.';
const block: PresentationBlock = { idx: 2, page: 3, text: `Methods. ${quote} Further measurements are needed.`, isRef: false };
const evidence = presentationEvidence([block]);
function generated() {
  return { title: 'Resonator measurements', slides: Array.from({ length: 3 }, (_, i) => ({ title: `Slide ${i + 1}`, seconds: 60, bullets: ['Three independent measurements at 10 kelvin'], script: 'The authors measured resonator noise with a calibrated sensor. The sample is limited to three experiments.', sources: ['b2.0'] })), questions: Array.from({ length: 3 }, (_, i) => ({ question: `Question ${i + 1}?`, answer: 'Three independent experiments are reported. The paper does not establish generalization beyond this setting.', sources: ['b2.0'] })) };
}
function stored(): PresentationContent {
  return { version: 1, ...validatePresentationGeneration(generated(), evidence, 3), paperTitle: 'Original paper', durationMinutes: 3, createdAt: '2026-11-03T01:02:03Z', by, analysis: { status: 'none', updatedAt: null, callsDone: null, truncated: false } };
}
function finishJob(id: string): Promise<JobRow> {
  const current = getJobRow(id)!;
  if (current.status === 'done' || current.status === 'error') return Promise.resolve(current);
  const { promise, resolve } = Promise.withResolvers<JobRow>();
  subscribeJob(id, (event) => { if (event.event === 'done' || event.event === 'error') resolve(getJobRow(id)!); });
  return promise;
}

beforeEach(() => {
  db.prepare('DELETE FROM jobs').run();
  db.prepare('DELETE FROM papers').run();
  db.prepare('INSERT INTO papers(id,title,field,created_at,updated_at) VALUES(?,?,?,?,?)').run('paper', 'Original paper', 'physics', '2026-11-03', '2026-11-03');
  db.prepare('INSERT INTO blocks(paper_id,idx,page,text,lines,page_w,page_h) VALUES(?,?,?,?,?,?,?)').run('paper', block.idx, block.page, block.text, '[]', 600, 800);
  vi.mocked(runLlm).mockReset().mockResolvedValue({ text: JSON.stringify(generated()), by });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('presentation duration and literal paper evidence', () => {
  it.each([null, '10', 2, 61, 3.5, NaN])('rejects duration %s without coercion', (duration) => {
    expect(() => validatePresentationDuration(duration)).toThrow();
    expect(() => startPresentation('paper', duration)).toThrow();
    expect(runLlm).not.toHaveBeenCalled();
  });
  it('resolves selected source IDs to exact PDF text, including line wraps and ligatures', () => {
    const wrapped = { ...block, text: `  ${block.text.replace('noise at', 'noise\n at')} The ﬁeld ofﬂine result is unchanged.  ` };
    const content = validatePresentationGeneration(generated(), presentationEvidence([wrapped]), 3);
    const source = content.slides[0].sources[0];
    expect(source).toMatchObject({ blockIdx: 2, page: 3, start: 2 });
    expect(wrapped.text.slice(source.start, source.end)).toBe(source.quote);
    expect(source.quote).toContain('ﬁeld ofﬂine');
    expect(content.questions[0].sources[0]).toEqual(source);
  });
  it('rejects invented IDs, model-copied quotes and IDs belonging only to references', () => {
    for (const source of ['b999.0', 'b2.999', 'p.3', { page: 3, quote }]) {
      const raw = generated();
      const malformed = { ...raw, slides: raw.slides.map((slide, index) => index === 0 ? { ...slide, sources: [source] } : slide) };
      expect(() => validatePresentationGeneration(malformed, evidence, 3)).toThrow('근거 ID');
    }
    expect(() => validatePresentationGeneration(generated(), presentationEvidence([{ ...block, isRef: true }]), 3)).toThrow();
    const raw = generated();
    raw.questions[0].sources = ['b999.0'];
    expect(() => validatePresentationGeneration(raw, evidence, 3)).toThrow('근거 ID');
  });
  it('segments long blocks into bounded literal excerpts with unique IDs and retained offsets', () => {
    const long = { ...block, text: '  Long PDF evidence with a line\nbreak and ﬁgure reference. '.repeat(120) };
    const sources = presentationEvidence([long, { ...long, idx: 9, isRef: true }]);
    expect(sources.length).toBeGreaterThan(1);
    expect(new Set(sources.map((entry) => entry.id)).size).toBe(sources.length);
    for (const { source } of sources) {
      expect(source.blockIdx).toBe(2);
      expect(source.quote.length).toBeLessThanOrEqual(1800);
      expect(long.text.slice(source.start, source.end)).toBe(source.quote);
    }
  });
  it('requires exact total time, usable scripts and evidence for every slide and answer', () => {
    const raw = generated();
    raw.slides[0].seconds = 59;
    expect(() => validatePresentationGeneration(raw, evidence, 3)).toThrow('시간의 합');
    raw.slides[0].seconds = 60;
    raw.slides[1].script = ' ';
    expect(() => validatePresentationGeneration(raw, evidence, 3)).toThrow('대본');
    raw.slides[1].script = 'A spoken script.';
    raw.questions[0].sources = [];
    expect(() => validatePresentationGeneration(raw, evidence, 3)).toThrow('질문 근거');
  });
});

describe('presentation generation, artifacts and cancellation', () => {
  it('generates without saved analysis, persists one synced artifact, and records returned metadata', async () => {
    const actualBy = { engine: 'codex' as const, model: 'reported-model', effort: '' };
    vi.mocked(runLlm).mockResolvedValue({ text: JSON.stringify(generated()), by: actualBy });
    expect((await finishJob(startPresentation('paper', 3))).status).toBe('done');
    expect(runLlm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runLlm).mock.calls[0][0]).toMatchObject({ profile: 'heavy', model: by });
    const saved = readPresentation('paper')!;
    expect(saved.by).toEqual(actualBy);
    expect(saved.analysis).toEqual({ status: 'none', updatedAt: null, callsDone: null, truncated: false });
    expect(saved.slides).toHaveLength(3);
    const artifact = getArtifact('paper', 'presentation')!;
    expect(JSON.parse(artifact.made_by!)).toEqual(actualBy);
    expect(JSON.parse(artifact.content)).toEqual(saved);
  });
  it('uses partial saved analysis as a snapshot without creating or changing analysis', async () => {
    putArtifact('paper', 'analysis', 'Saved methods notes', { callsDone: 1 }, by);
    const original = getArtifact('paper', 'analysis')!;
    expect((await finishJob(startPresentation('paper', 3))).status).toBe('done');
    const request = vi.mocked(runLlm).mock.calls[0][0];
    expect(request.prompt).toContain('Saved methods notes');
    expect(readPresentation('paper')!.analysis).toEqual({ status: 'partial', callsDone: 1, updatedAt: original.updated_at, truncated: false });
    expect(getArtifact('paper', 'analysis')).toEqual(original);
    expect(runLlm).toHaveBeenCalledTimes(1);
  });
  it('distinguishes unknown completion from complete and marks clipped analysis', () => {
    putArtifact('paper', 'analysis', 'Legacy analysis', {}, by);
    expect(presentationAnalysis('paper').info.status).toBe('unknown');
    putArtifact('paper', 'analysis', 'a'.repeat(80_001), { callsDone: 3 }, by);
    const snapshot = presentationAnalysis('paper');
    expect(snapshot.info).toMatchObject({ status: 'complete', truncated: true });
    expect(snapshot.text).toHaveLength(80_000);
  });
  it('keeps the previous artifact when generation is invalid and does not silently retry', async () => {
    const content = stored();
    putArtifact('paper', 'presentation', JSON.stringify(content), { version: 1 }, by);
    const previous = getArtifact('paper', 'presentation');
    const raw = generated();
    raw.slides[0].seconds = 61;
    vi.mocked(runLlm).mockResolvedValue({ text: JSON.stringify(raw), by });
    expect((await finishJob(startPresentation('paper', 3))).status).toBe('error');
    expect(getArtifact('paper', 'presentation')).toEqual(previous);
    expect(runLlm).toHaveBeenCalledTimes(1);
  });
  it('does not save even if a cancelled model later returns a valid response', async () => {
    putArtifact('paper', 'presentation', JSON.stringify(stored()), { version: 1 }, by);
    const previous = getArtifact('paper', 'presentation');
    const deferred = Promise.withResolvers<LlmResult>();
    vi.mocked(runLlm).mockReturnValue(deferred.promise);
    const id = startPresentation('paper', 3);
    expect(cancelJob(id)).toBe(true);
    deferred.resolve({ text: JSON.stringify(generated()), by });
    expect((await finishJob(id)).status).toBe('error');
    expect(getArtifact('paper', 'presentation')).toEqual(previous);
  });
  it('refuses missing body and corrupt saved data without model calls', () => {
    db.prepare('DELETE FROM blocks').run();
    expect(() => startPresentation('paper', 3)).toThrow('PDF 본문');
    expect(runLlm).not.toHaveBeenCalled();
    putArtifact('paper', 'presentation', '{broken', {}, by);
    expect(() => readPresentation('paper')).toThrow('그대로 보관');
    expect(getArtifact('paper', 'presentation')!.content).toBe('{broken');
  });
});

describe('presentation routes and Markdown export', () => {
  it('returns saved content and current analysis without invoking AI', async () => {
    const content = stored();
    putArtifact('paper', 'presentation', JSON.stringify(content), { version: 1 }, by);
    const response = await app.request('/api/papers/paper/presentation');
    expect(response.status).toBe(200);
    const body = await response.json() as PresentationResponse;
    expect(body.presentation).toEqual(content);
    expect(body.analysis.status).toBe('none');
    expect(runLlm).not.toHaveBeenCalled();
    expect(parsePresentationContent(JSON.parse(JSON.stringify(content)))).toEqual(content);
  });
  it('rejects invalid JSON, missing or out-of-range duration before creating jobs', async () => {
    for (const body of ['{broken', '{}', '{"durationMinutes":0}', '{"durationMinutes":"3"}']) {
      const response = await app.request('/api/papers/paper/presentation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      expect(response.status).toBe(400);
    }
    expect(runLlm).not.toHaveBeenCalled();
  });
  it('exports saved outline, full scripts, questions, evidence and provenance without generation', async () => {
    const content = stored();
    putArtifact('paper', 'presentation', JSON.stringify(content), { version: 1 }, by);
    const response = await app.request('/api/papers/paper/presentation/export');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/markdown');
    expect(response.headers.get('Content-Disposition')).toContain('attachment');
    const markdown = await response.text();
    expect(markdown).toBe(presentationMarkdown(content));
    for (const slide of content.slides) {
      expect(markdown).toContain(slide.title);
      expect(markdown).toContain(slide.script);
      expect(markdown).toContain(slide.sources[0].quote);
    }
    expect(markdown).toContain(content.questions[0].answer);
    expect(markdown).toContain('presentation-model');
    expect(markdown).toContain('120–180초');
    expect(runLlm).not.toHaveBeenCalled();
  });
  it('starts a duration-specific job through POST and exposes its persisted result through GET', async () => {
    const response = await app.request('/api/papers/paper/presentation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ durationMinutes: 3 }),
    });
    expect(response.status).toBe(200);
    const { jobId } = await response.json() as { jobId: string };
    expect((await finishJob(jobId)).status).toBe('done');
    const saved = await (await app.request('/api/papers/paper/presentation')).json() as PresentationResponse;
    expect(saved.presentation).toMatchObject({ durationMinutes: 3, paperTitle: 'Original paper', by });
    expect(saved.presentation!.slides.reduce((sum, slide) => sum + slide.seconds, 0)).toBe(180);
  });
  it('returns not found rather than exporting an empty presentation', async () => {
    expect((await app.request('/api/papers/paper/presentation/export')).status).toBe(404);
    expect((await app.request('/api/papers/missing/presentation')).status).toBe(404);
  });
});
