import { join } from 'node:path';
import type { LayoutTranslationDocument, LayoutTranslationPage, LayoutTranslationRegion } from '../../shared/layout-translation';
import { resolveField } from '../../shared/fields';
import { PATHS } from '../config';
import { getArtifact, getPaper, now, putArtifact } from '../db';
import { HttpError } from '../http-error';
import { fieldGuide } from '../fields';
import { activeJob, startJob, type JobCtx } from '../jobs';
import { parseJsonLoose } from '../json';
import { resolveModel, runLlm, type ModelSpec } from '../llm';
import { abortableLayoutWork, createLayoutOcr, extractLayoutPage, layoutPdfHash, MAX_LAYOUT_PAGES, openLayoutPdf, type LayoutOcrWorker, type LayoutPdf } from '../pdf/layout-translation';
import { tokensPreserved } from '../pdf/layout-translation-geometry';
import { fill, loadPrompt } from '../prompts';

const MAX_ARTIFACT_CHARS = 20_000_000;
const MAX_BATCH_CHARS = 10_000;
const MAX_BATCH_REGIONS = 32;
const EXTRACTION_VERSION = 3;
let runningLayoutJobs = 0;
export interface LayoutTranslationOptions { pages?: number[]; ocr?: boolean }

export function validateLayoutOptions(value: unknown, pageCount?: number): LayoutTranslationOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'JSON 요청이 올바르지 않습니다');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'pages' && key !== 'ocr')) throw new HttpError(400, '지원하지 않는 원문 배치 번역 옵션입니다');
  if (input.ocr !== undefined && typeof input.ocr !== 'boolean') throw new HttpError(400, 'ocr는 true 또는 false여야 합니다');
  let pages: number[] | undefined;
  if (input.pages !== undefined) {
    if (!Array.isArray(input.pages) || !input.pages.length || input.pages.length > MAX_LAYOUT_PAGES || input.pages.some((page) => !Number.isInteger(page) || page < 1 || page > (pageCount ?? MAX_LAYOUT_PAGES))) throw new HttpError(400, '페이지 번호가 PDF 범위를 벗어나거나 올바르지 않습니다');
    pages = [...new Set(input.pages as number[])].sort((a, b) => a - b);
  }
  return { ...(pages ? { pages } : {}), ocr: input.ocr === true };
}

/** Treat synchronized artifacts as untrusted: never draw malformed or unbounded geometry. */
export function parseLayoutDocument(content: string, pdfHash: string): LayoutTranslationDocument | null {
  if (content.length > MAX_ARTIFACT_CHARS) return null;
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const doc = raw as LayoutTranslationDocument;
  if (doc.version !== 1 || doc.pdfHash !== pdfHash || !/^[a-f0-9]{64}$/.test(doc.pdfHash) || !Array.isArray(doc.pages) || doc.pages.length > MAX_LAYOUT_PAGES || typeof doc.ocr !== 'boolean' || typeof doc.updatedAt !== 'string') return null;
  if (doc.by !== null && (!doc.by || !['claude', 'codex'].includes(doc.by.engine) || doc.by.model !== undefined && typeof doc.by.model !== 'string' || doc.by.effort !== undefined && typeof doc.by.effort !== 'string')) return null;
  const pageIds = new Set<number>();
  let regionCount = 0;
  for (const page of doc.pages) {
    if (!page || !Number.isInteger(page.page) || page.page < 1 || page.page > MAX_LAYOUT_PAGES || pageIds.has(page.page) || ![page.width, page.height].every((n) => Number.isFinite(n) && n > 0 && n <= 100_000) || !Array.isArray(page.regions) || page.regions.length > 12_000 || !Array.isArray(page.warnings) || page.warnings.length > 1000 || page.warnings.some((warning) => typeof warning !== 'string')) return null;
    pageIds.add(page.page);
    const ids = new Set<string>();
    for (const region of page.regions) {
      if (!region || typeof region.id !== 'string' || region.id.length > 100 || ids.has(region.id) || typeof region.source !== 'string' || region.source.length > 100_000 || region.ko !== null && typeof region.ko !== 'string' || !Array.isArray(region.box) || region.box.length !== 4 || !region.box.every(Number.isFinite) || region.box[2] <= 0 || region.box[3] <= 0 || region.box.some((n) => Math.abs(n) > 200_000) || !Number.isFinite(region.fontSize) || region.fontSize <= 0 || !Number.isFinite(region.rotation) || !['pdf', 'ocr'].includes(region.origin) || !['text', 'protected'].includes(region.kind) || !Number.isFinite(region.confidence) || region.confidence < 0 || region.confidence > 1 || typeof region.safe !== 'boolean' || region.reason !== undefined && typeof region.reason !== 'string') return null;
      ids.add(region.id);
      if (++regionCount > 250_000) return null;
    }
  }
  return doc;
}

export async function readLayoutTranslation(paperId: string): Promise<LayoutTranslationDocument | null> {
  const paper = getPaper(paperId);
  if (!paper?.pdf_file) return null;
  const artifact = getArtifact(paperId, 'layoutTranslation');
  if (!artifact) return null;
  return parseLayoutDocument(artifact.content, await layoutPdfHash(join(PATHS.pdfs, paper.pdf_file)));
}

export interface MaskedLayoutSource {
  source: string;
  tokens: Array<[string, string]>;
}
export interface LayoutTranslationBatchResult {
  values: Map<string, string | null>;
  errors: Map<string, string>;
  preserved: Set<string>;
}
const MODEL_PRESERVED_REASON = '모델이 번역 불가 또는 고유명사로 명시하여 원문 보존';

/** Opaque placeholders prevent the model from rounding numbers or rewriting dates/units. */
export function maskLayoutSource(source: string): MaskedLayoutSource {
  let prefix = 'PLT';
  while (source.includes(`⟦${prefix}`)) prefix += 'X';
  const tokens: Array<[string, string]> = [];
  const masked = source.replace(/\b(?:\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})\b|\b(?:[A-Za-z][A-Za-z0-9_.:-]*\d[A-Za-z0-9_.:-]*|[a-z]+[A-Z]{2,}(?:-[A-Za-z]+)*)\b|[+−-]?\d+(?:[.,]\d+)*(?:[eE][+−-]?\d+)?(?:\s*[mkMµμncp]?(?:Hz|Pa|mol|g|m|L|K|s|V|W|J|N|A|Bq|Gy|Sv)\b)?|[%=+−×÷^_{}<>\u0370-\u03ff\u2100-\u214f\u2190-\u22ff]/gu, (value) => {
    const placeholder = `⟦${prefix}${tokens.length}⟧`;
    tokens.push([placeholder, value]);
    return placeholder;
  });
  return { source: masked, tokens };
}

/** Exact IDs are batch-level; malformed content affects only its own region. */
export function validateLayoutTranslations(text: string, regions: Pick<LayoutTranslationRegion, 'id' | 'source'>[], masks?: Map<string, MaskedLayoutSource>): LayoutTranslationBatchResult {
  const parsed = parseJsonLoose<unknown>(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('배치 번역 응답이 JSON 객체가 아닙니다');
  const object = parsed as Record<string, unknown>;
  const expected = new Set(regions.map((region) => region.id));
  const keys = Object.keys(object);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key)) || [...expected].some((key) => !Object.hasOwn(object, key))) throw new Error('배치 번역 ID가 누락되었거나 일치하지 않습니다');
  const result: LayoutTranslationBatchResult = { values: new Map(), errors: new Map(), preserved: new Set() };
  for (const region of regions) {
    try {
      const candidate = object[region.id];
      if (candidate === null) { result.values.set(region.id, null); result.preserved.add(region.id); continue; }
      if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > Math.max(2000, region.source.length * 8)) throw new Error('번역 응답이 비었거나 올바르지 않습니다');
      let value: string = candidate;
      for (const [placeholder, original] of masks?.get(region.id)?.tokens ?? []) {
        const occurrences = value.split(placeholder).length - 1;
        if (occurrences > 1) throw new Error(`보호 토큰 ${placeholder}가 중복되었습니다`);
        if (occurrences === 1) value = value.replace(placeholder, original);
      }
      if (/[⟦⟧]/u.test(value)) throw new Error('보호 토큰 표기가 손상되었거나 알 수 없는 보호 토큰이 있습니다');
      if (value.trim().replace(/\s+/gu, ' ') === region.source.trim().replace(/\s+/gu, ' ')) {
        const words = region.source.trim().split(/\s+/u);
        const properName = words.length >= 2 && words.length <= 12 && region.source.length <= 160 && words.every((word) => /^(?:[A-Z][A-Za-z.'’,-]*|of|and|the|&)$/.test(word));
        const identifier = /^(?=(?:[^A-Z]*[A-Z]){2})[A-Za-z0-9-]+$/.test(region.source.trim());
        if (!properName && !identifier) throw new Error('원문을 그대로 반환하여 한국어 번역이 없습니다');
        result.values.set(region.id, null);
        result.preserved.add(region.id);
        continue;
      }
      if (!/[가-힣]/u.test(value)) throw new Error('실제 한국어 번역이 없습니다');
      if (!tokensPreserved(region.source, value)) throw new Error('숫자·과학 기호가 원문과 다릅니다');
      result.values.set(region.id, value.trim());
    } catch (error) { result.errors.set(region.id, error instanceof Error ? error.message : String(error)); }
  }
  return result;
}

export function layoutBatches(regions: LayoutTranslationRegion[]): LayoutTranslationRegion[][] {
  const batches: LayoutTranslationRegion[][] = [];
  let current: LayoutTranslationRegion[] = [];
  let chars = 0;
  for (const region of regions) {
    if (region.kind !== 'text' || region.ko !== null) continue;
    if (region.source.length > MAX_BATCH_CHARS) throw new Error(`${region.id}: 단일 텍스트가 10,000자 처리 한도를 초과했습니다`);
    if (current.length && (current.length >= MAX_BATCH_REGIONS || chars + region.source.length > MAX_BATCH_CHARS)) { batches.push(current); current = []; chars = 0; }
    current.push(region);
    chars += region.source.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Replace only a completed extraction; merge successful translations from the same exact PDF. */
export function mergeLayoutPage(previous: LayoutTranslationPage | undefined, extracted: LayoutTranslationPage, keepPreviousOcr: boolean): LayoutTranslationPage {
  if (!previous) return extracted;
  const prior = new Map(previous.regions.map((region) => [region.id, region]));
  for (const region of extracted.regions) {
    const old = prior.get(region.id);
    if (old && old.source === region.source && old.origin === region.origin) {
      if (old.ko && tokensPreserved(region.source, old.ko)) region.ko = old.ko;
      else if (old.kind === 'protected' && old.reason === MODEL_PRESERVED_REASON) { region.kind = 'protected'; region.safe = false; region.reason = old.reason; }
    }
  }
  if (keepPreviousOcr) {
    extracted.regions.push(...previous.regions.filter((region) => region.origin === 'ocr'));
    extracted.warnings = [...new Set([...extracted.warnings, ...previous.warnings.filter((warning) => warning.startsWith('OCR'))])];
  }
  return extracted;
}

interface SavedLayout { document: LayoutTranslationDocument; ocrPages: Set<number>; geometryPages: Set<number> }
function storedLayout(paperId: string, hash: string): SavedLayout {
  const artifact = getArtifact(paperId, 'layoutTranslation');
  const document = artifact ? parseLayoutDocument(artifact.content, hash) : null;
  let ocrPages = new Set<number>();
  let geometryPages = new Set<number>();
  if (document && artifact) {
    try {
      const meta = JSON.parse(artifact.meta) as { ocrPages?: unknown; geometryPages?: unknown; extractionVersion?: unknown };
      if (Array.isArray(meta.ocrPages)) ocrPages = new Set(meta.ocrPages.filter((page): page is number => Number.isInteger(page) && document.pages.some((item) => item.page === page)));
      if (meta.extractionVersion === EXTRACTION_VERSION && Array.isArray(meta.geometryPages)) geometryPages = new Set(meta.geometryPages.filter((page): page is number => Number.isInteger(page) && document.pages.some((item) => item.page === page)));
    } catch { /* Old/malformed metadata never claims OCR coverage. */ }
  }
  return { document: document ?? { version: 1, pdfHash: hash, pages: [], by: null, updatedAt: now(), ocr: false }, ocrPages, geometryPages };
}

async function runLayoutTranslation(paperId: string, pdfFile: string, opened: LayoutPdf, options: LayoutTranslationOptions, ctx: JobCtx): Promise<void> {
  const state = storedLayout(paperId, opened.hash);
  const pages = options.pages ?? Array.from({ length: opened.pdf.numPages }, (_, i) => i + 1);
  let worker: LayoutOcrWorker | null = null;
  let terminated = false;
  const terminate = async () => { if (worker && !terminated) { terminated = true; await worker.terminate(); } };
  const abort = () => { void terminate(); void opened.close(); };
  ctx.signal.addEventListener('abort', abort, { once: true });
  let errors = 0;
  const persist = () => {
    ctx.signal.throwIfAborted();
    if (getPaper(paperId)?.pdf_file !== pdfFile) throw new Error('PDF가 작업 중 변경되어 번역을 저장하지 않습니다');
    state.document.pages.sort((a, b) => a.page - b.page);
    state.document.updatedAt = now();
    state.document.ocr = state.ocrPages.size > 0;
    if (state.document.pages.reduce((count, page) => count + page.regions.length, 0) > 250_000) throw new Error('원문 배치 번역 문서가 250,000개 영역 저장 한도를 초과했습니다');
    const content = JSON.stringify(state.document);
    if (content.length > MAX_ARTIFACT_CHARS) throw new Error('원문 배치 번역 문서가 20MB 저장 한도를 초과했습니다');
    putArtifact(paperId, 'layoutTranslation', content, { ocrPages: [...state.ocrPages], geometryPages: [...state.geometryPages], extractionVersion: EXTRACTION_VERSION }, state.document.by);
  };
  try {
    const prompt = loadPrompt('layout-translation');
    const paper = getPaper(paperId);
    if (!paper) throw new Error('논문이 삭제되어 번역을 계속할 수 없습니다');
    const guide = fieldGuide(resolveField(paper.field, paper.field_suggested));
    let model: ModelSpec | null = null;
    for (let index = 0; index < pages.length; index++) {
      ctx.signal.throwIfAborted();
      const number = pages[index];
      const previous = state.document.pages.find((page) => page.page === number);
      if (previous && state.geometryPages.has(number) && !previous.warnings.some((warning) => warning.includes('처리 실패')) && previous.regions.every((region) => region.kind === 'protected' || region.ko !== null) && (!options.ocr || state.ocrPages.has(number))) { ctx.progress((index + 1) / pages.length, `p.${number} 저장된 번역 재사용`); continue; }
      ctx.message(`p.${number} 원문 좌표·그림 안전성${options.ocr ? '·로컬 OCR' : ''} 처리 중`);
      const page = await abortableLayoutWork(opened.pdf.getPage(number), ctx.signal);
      try {
        const pageSignal = AbortSignal.any([ctx.signal, AbortSignal.timeout(180_000)]);
        if (options.ocr && !worker) worker = await createLayoutOcr(ctx.signal);
        const extracted = await extractLayoutPage(page, options.ocr ? worker : null, pageSignal);
        if (await layoutPdfHash(join(PATHS.pdfs, pdfFile)) !== opened.hash) throw new Error('PDF 내용이 작업 중 변경되었습니다');
        const translated = mergeLayoutPage(previous, extracted, !options.ocr && state.ocrPages.has(number));
        const oldIndex = state.document.pages.findIndex((entry) => entry.page === number);
        if (oldIndex < 0) state.document.pages.push(translated); else state.document.pages[oldIndex] = translated;
        if (options.ocr) state.ocrPages.add(number);
        state.geometryPages.add(number);
        persist();
        for (const batch of layoutBatches(translated.regions)) {
          ctx.signal.throwIfAborted();
          model ??= resolveModel('quick');
          try {
            const masks = new Map(batch.map((region) => [region.id, maskLayoutSource(region.source)]));
            const result = await runLlm({ system: `${prompt.SYSTEM}\n\n분야별 용어 지침:\n${guide}`, prompt: fill(prompt.BATCH, { regions_json: JSON.stringify(Object.fromEntries(batch.map((region) => [region.id, { source: masks.get(region.id)!.source }]))) }), profile: 'quick', model, signal: ctx.signal });
            ctx.signal.throwIfAborted();
            const validated = validateLayoutTranslations(result.text, batch, masks);
            for (const region of batch) {
              if (validated.values.has(region.id)) region.ko = validated.values.get(region.id)!;
              if (validated.preserved.has(region.id)) { region.kind = 'protected'; region.safe = false; region.reason = MODEL_PRESERVED_REASON; }
            }
            state.document.by = result.by;
            if (validated.preserved.size) translated.warnings.push(`${[...validated.preserved].join(', ')}: 번역 불가·고유명사로 명시된 원문을 보존했으며 한국어 번역으로 계산하지 않습니다.`);
            if (validated.errors.size) {
              errors += validated.errors.size;
              translated.warnings.push(`일부 영역 번역 실패: ${[...validated.errors].map(([id, message]) => `${id}: ${message}`).join('; ')}. 같은 배치의 유효한 번역은 저장했습니다.`);
            }
            persist();
            ctx.emit('page', { page: number, document: state.document });
          } catch (error) {
            ctx.signal.throwIfAborted();
            errors++;
            translated.warnings.push(`번역 배치 실패 (${batch[0].id}–${batch[batch.length - 1].id}): ${error instanceof Error ? error.message : String(error)}. 기존 번역은 유지됩니다.`);
            persist();
          }
        }
        const missing = translated.regions.filter((region) => region.kind === 'text' && region.ko === null).length;
        if (missing) {
          errors++;
          translated.warnings.push(`${missing}개 영역의 한국어가 아직 없습니다. 원문은 보존되며 다시 생성하면 미완료 영역만 처리합니다.`);
          persist();
        }
        ctx.emit('page', { page: number, document: state.document });
      } catch (error) {
        ctx.signal.throwIfAborted();
        if (worker) { await terminate(); worker = null; terminated = false; }
        errors++;
        const retained = state.document.pages.find((entry) => entry.page === number);
        const warning = `p.${number} 처리 실패: ${error instanceof Error ? error.message : String(error)}. 기존 성공 결과는 보존됩니다.`;
        if (retained) retained.warnings.push(warning);
        else {
          const viewport = page.getViewport({ scale: 1 });
          state.document.pages.push({ page: number, width: viewport.width, height: viewport.height, regions: [], warnings: [warning] });
        }
        persist();
        ctx.message(warning);
        ctx.emit('page', { page: number, document: state.document, warning });
      } finally { page.cleanup(); }
      ctx.progress((index + 1) / pages.length, `p.${number} 처리 완료`);
    }
    if (errors) throw new Error('일부 원문 배치 번역이 완료되지 않았습니다. 저장된 페이지와 경고를 확인하고 다시 생성하세요.');
  } finally {
    ctx.signal.removeEventListener('abort', abort);
    try { await terminate(); await opened.close(); }
    finally { runningLayoutJobs--; }
  }
}

export async function startLayoutTranslation(paperId: string, input: unknown = {}): Promise<string> {
  const options = validateLayoutOptions(input);
  const paper = getPaper(paperId);
  if (!paper) throw new HttpError(404, '논문을 찾을 수 없습니다');
  if (!paper.pdf_file) throw new HttpError(400, 'PDF를 먼저 붙이세요');
  const running = activeJob(paperId, 'layoutTranslation');
  if (running) return running.id;
  if (runningLayoutJobs >= 2) throw new HttpError(429, '원문 배치 번역은 동시에 두 논문까지 처리할 수 있습니다');
  runningLayoutJobs++;
  let opened: LayoutPdf | null = null;
  try {
    opened = await openLayoutPdf(join(PATHS.pdfs, paper.pdf_file));
    validateLayoutOptions(options, opened.pdf.numPages);
    const existing = activeJob(paperId, 'layoutTranslation');
    if (existing) { runningLayoutJobs--; await opened.close(); return existing.id; }
    const document = opened;
    return startJob(paperId, 'layoutTranslation', (ctx) => runLayoutTranslation(paperId, paper.pdf_file!, document, options, ctx));
  } catch (error) { runningLayoutJobs--; await opened?.close(); throw error; }
}
