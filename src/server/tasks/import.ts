import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { FieldId } from '../../shared/fields';
import { PATHS } from '../config';
import { db, getBlocks, getPaper, now, refreshFts, tx, type Author } from '../db';
import { HttpError } from '../http-error';
import { activeJob, startJob, type JobCtx } from '../jobs';
import { extractBlocks, type ExtractionResult } from '../pdf/extract';
import { LAYOUT_VERSION } from '../pdf/layout';
import * as arxiv from '../services/arxiv';
import * as crossref from '../services/crossref';
import { getBuffer } from '../services/http';
import * as openalex from '../services/openalex';
import * as unpaywall from '../services/unpaywall';

export type ImportInput = { kind: 'doi'; doi: string } | { kind: 'arxiv'; id: string } | { kind: 'openalex'; id: string };

const DOI_RE = /10\.\d{4,9}\/[^\s"<>]+/i;
const ARXIV_DOI = /10\.48550\/arxiv\.(\d{4}\.\d{4,5}|[a-z][a-z-]*(?:\.[A-Za-z]{2})?\/\d{7})/i;
const ARXIV_ID = /(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)?(\d{4}\.\d{4,5}|[a-z][a-z-]*(?:\.[A-Za-z]{2})?\/\d{7})(?:v\d+)?/i;
const ARXIV_IN_TEXT = /arXiv:\s*(\d{4}\.\d{4,5}|[a-z][a-z-]*(?:\.[A-Za-z]{2})?\/\d{7})(?:v\d+)?/i;

export function normalizeDoi(raw: string): string {
  return raw.replace(/[.,;)]+$/, '').toLowerCase();
}

export function findDoi(text: string): string | null {
  const m = DOI_RE.exec(text);
  return m ? normalizeDoi(m[0]) : null;
}

export function parseImportInput(s: string): ImportInput {
  let input: string;
  try {
    input = decodeURIComponent(s.trim());
  } catch {
    throw new HttpError(400, 'DOI, arXiv 또는 OpenAlex 링크가 아닙니다');
  }
  const work = /^(?:https?:\/\/openalex\.org\/)?(W\d+)$/i.exec(input);
  if (work) return { kind: 'openalex', id: work[1].toUpperCase() };
  const arxivDoi = ARXIV_DOI.exec(input);
  if (arxivDoi) return { kind: 'arxiv', id: arxivDoi[1] };
  const doi = findDoi(input);
  if (doi) return { kind: 'doi', doi };
  const ax = ARXIV_ID.exec(input);
  if (ax) return { kind: 'arxiv', id: ax[1] };
  throw new HttpError(400, 'DOI, arXiv 또는 OpenAlex 링크가 아닙니다');
}

export function arxivYear(id: string): number {
  const oldStyle = id.includes('/');
  const yy = parseInt(oldStyle ? id.slice(id.indexOf('/') + 1, id.indexOf('/') + 3) : id.slice(0, 2), 10);
  return oldStyle && yy >= 91 ? 1900 + yy : 2000 + yy;
}

export function paperIdByDoi(doi: string): string | null {
  const row = db.prepare('SELECT id FROM papers WHERE doi=?').get(doi) as { id: string } | undefined;
  return row?.id ?? null;
}

interface NewPaper {
  title: string;
  authors?: Author[];
  year?: number | null;
  journal?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  doi?: string | null;
  arxiv_id?: string | null;
  openalex_id?: string | null;
  pmid?: string | null;
  pmcid?: string | null;
  abstract?: string | null;
  field?: FieldId | null;
}

function insertPaper(p: NewPaper): string {
  const id = nanoid(10);
  const t = now();
  db.prepare(
    `INSERT INTO papers(id,title,authors,year,journal,volume,issue,pages,doi,arxiv_id,openalex_id,pmid,pmcid,abstract,field,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    p.title,
    JSON.stringify(p.authors ?? []),
    p.year ?? null,
    p.journal ?? null,
    p.volume ?? null,
    p.issue ?? null,
    p.pages ?? null,
    p.doi ?? null,
    p.arxiv_id ?? null,
    p.openalex_id ?? null,
    p.pmid ?? null,
    p.pmcid ?? null,
    p.abstract ?? null,
    p.field ?? null,
    t,
    t,
  );
  refreshFts(id);
  return id;
}

/** Split "Ashish Vaswani" into {family:"Vaswani", given:"Ashish"}. */
function splitName(display: string): Author {
  const parts = display.trim().split(/\s+/);
  const family = parts.pop() ?? '';
  return { family, given: parts.join(' ') || undefined };
}

export const pdfPath = (paperId: string) => join(PATHS.pdfs, `${paperId}.pdf`);

/** Replace a paper's blocks (dropping translations, which are keyed to them) and refresh FTS. */
function storeBlocks(paperId: string, { pageCount, blocks }: ExtractionResult): void {
  tx(() => {
    db.prepare('DELETE FROM translations WHERE paper_id=?').run(paperId);
    db.prepare('DELETE FROM blocks WHERE paper_id=?').run(paperId);
    const ins = db.prepare('INSERT INTO blocks(paper_id,idx,page,text,lines,page_w,page_h,is_ref,kind,spans) VALUES(?,?,?,?,?,?,?,?,?,?)');
    for (const b of blocks) {
      ins.run(paperId, b.idx, b.page, b.text, JSON.stringify(b.lines), b.pageW, b.pageH, b.isRef ? 1 : 0, b.kind, JSON.stringify(b.spans));
    }
    db.prepare('UPDATE papers SET pdf_file=?, page_count=?, layout_version=?, updated_at=? WHERE id=?')
      .run(`${paperId}.pdf`, pageCount, LAYOUT_VERSION, now(), paperId);
  });
  refreshFts(paperId);
}

/** Extract text blocks from the paper's PDF into `blocks`, `page_count` and FTS. */
export async function ingestPdf(paperId: string, ctx: JobCtx, extracted?: ExtractionResult): Promise<void> {
  ctx.progress(0.7, '텍스트 추출 중');
  const result = extracted ?? await extractBlocks(pdfPath(paperId));
  storeBlocks(paperId, result);
  const paragraphs = result.blocks.filter((b) => b.kind === 'body').length;
  ctx.progress(1, result.blocks.length ? `PDF 저장 완료 · ${result.pageCount}쪽 · 문단 ${paragraphs}개` : 'PDF 저장 완료 — 텍스트 레이어가 없는 스캔본이므로 AI 기능을 쓸 수 없습니다');
}

/** Extract `pdfs/<paperId>.pdf` (just written by sync) into blocks; drops the paper's translations. */
export async function extractPaperPdf(paperId: string): Promise<void> {
  storeBlocks(paperId, await extractBlocks(pdfPath(paperId)));
}

const relayouts = new Map<string, Promise<void>>();

/** Only exact page/text matches can reuse offsets; repeated text also needs its original geometry. */
function upgradeBlockSpans(paperId: string, { blocks }: ExtractionResult): void {
  const stored = getBlocks(paperId);
  const keyOf = (block: { page: number; text: string }) => JSON.stringify([block.page, block.text]);
  const extractedByText = new Map<string, ExtractionResult['blocks']>();
  const storedCounts = new Map<string, number>();
  for (const block of blocks) {
    const key = keyOf(block);
    const group = extractedByText.get(key);
    if (group) group.push(block);
    else extractedByText.set(key, [block]);
  }
  for (const block of stored) {
    const key = keyOf(block);
    storedCounts.set(key, (storedCounts.get(key) ?? 0) + 1);
  }
  const update = db.prepare('UPDATE blocks SET spans=? WHERE paper_id=? AND idx=?');
  for (const block of stored) {
    const key = keyOf(block);
    const candidates = extractedByText.get(key) ?? [];
    const unique = candidates.length === 1 && storedCounts.get(key) === 1;
    // An index alone cannot distinguish repeated text after block boundaries have changed.
    const matches = unique ? candidates : candidates.filter((candidate) =>
      candidate.idx === block.idx &&
      candidate.pageW === block.page_w && candidate.pageH === block.page_h &&
      JSON.stringify(candidate.lines) === block.lines);
    if (matches.length === 1) update.run(JSON.stringify(matches[0].spans), paperId, block.idx);
  }
  // This layout's metadata was attempted even if some old blocks could not be matched safely.
  db.prepare('UPDATE papers SET layout_version=? WHERE id=?').run(LAYOUT_VERSION, paperId);
}

/**
 * Upgrade old PDF layouts locally. Untranslated/forced papers replace their blocks; translated
 * papers retain every block and translation and only gain trustworthy text-layer spans.
 * Never commits under an import or translation job, including one started during extraction.
 */
export function ensureCurrentLayout(paperId: string, { force = false }: { force?: boolean } = {}): Promise<void> {
  const paper = getPaper(paperId);
  if (!paper?.pdf_file || paper.layout_version >= LAYOUT_VERSION) return Promise.resolve();
  if (activeJob(paperId, 'import') || activeJob(paperId, 'translation')) return Promise.resolve();
  let pending = relayouts.get(paperId);
  if (!pending) {
    pending = extractBlocks(pdfPath(paperId))
      .then((extracted) => {
        const current = getPaper(paperId);
        if (!current?.pdf_file || current.pdf_file !== paper.pdf_file || current.layout_version >= LAYOUT_VERSION) return;
        if (activeJob(paperId, 'import') || activeJob(paperId, 'translation')) return;
        if (!force && db.prepare('SELECT 1 FROM translations WHERE paper_id=? LIMIT 1').get(paperId)) {
          tx(() => upgradeBlockSpans(paperId, extracted));
        } else {
          storeBlocks(paperId, extracted);
        }
      })
      // The existing blocks stay usable; the next open tries again.
      .catch(() => {})
      .finally(() => relayouts.delete(paperId));
    relayouts.set(paperId, pending);
  }
  return pending;
}

async function downloadPdf(url: string): Promise<Buffer | null> {
  try {
    const buf = await getBuffer(url);
    return buf && buf.subarray(0, 4).toString('latin1') === '%PDF' ? buf : null;
  } catch {
    return null;
  }
}

/** Fill metadata from Crossref and OpenAlex, accepting either source on its own. */
async function metadataForDoi(doi: string): Promise<{ meta: NewPaper; pdfUrls: string[] } | null> {
  const [cr, oa] = await Promise.all([crossref.getWork(doi).catch(() => null), openalex.getByDoi(doi).catch(() => null)]);
  const s = oa ? openalex.toSummary(oa) : null;
  if (!cr && !s?.title) return null;
  const meta: NewPaper = cr
    ? { ...cr, doi, openalex_id: s?.openalexId ?? null, pmid: s?.pmid ?? null, pmcid: s?.pmcid ?? null, abstract: cr.abstract ?? s?.abstract ?? null }
    : { title: s!.title, authors: s!.authors.map(splitName), year: s!.year, journal: s!.venue, abstract: s!.abstract, doi, openalex_id: s!.openalexId, pmid: s!.pmid, pmcid: s!.pmcid };
  const pdfUrls = oa ? openAlexPdfUrls(oa) : [];
  return { meta, pdfUrls };
}
/** Only provider-designated open-access locations are candidates. */
export function openAlexPdfUrls(work: openalex.OpenAlexWork): string[] {
  return [...new Set([work.best_oa_location?.pdf_url, ...(work.locations ?? []).filter((location) => location.is_oa).map((location) => location.pdf_url)]
    .filter((url): url is string => !!url))];
}
export function paperIdByOpenAlex(id: string | null | undefined): string | null {
  if (!id) return null;
  const short = openalex.shortId(id);
  const row = db.prepare('SELECT id FROM papers WHERE openalex_id=? OR openalex_id=?').get(short, `https://openalex.org/${short}`) as { id: string } | undefined;
  return row?.id ?? null;
}


function duplicateResult(paperId: string): ImportResult {
  const job = activeJob(paperId, 'import');
  return { paperId, duplicate: true, ...(job ? { jobId: job.id } : {}) };
}

/**
 * Reject only when the first page identifies a different DOI and offers no evidence
 * of the expected title. DOI differences alone are common across paper versions.
 * Missing text, short titles and unlabelled references are inconclusive.
 */
export function pdfIdentityConflict(paper: { title: string; doi: string | null }, extracted: ExtractionResult): boolean {
  if (!paper.doi) return false;
  const page = extracted.blocks.filter((block) => block.page === 1).map((block) => block.text).join(' ');
  if (page.length < 120) return false;
  const tokens = (text: string) => text.normalize('NFKD').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const titleWords = [...new Set(tokens(paper.title).filter((word) => word.length >= 2))];
  if (titleWords.length < 3) return false;
  const pageWords = new Set(tokens(`${extracted.title ?? ''} ${page}`));
  if (titleWords.filter((word) => pageWords.has(word)).length / titleWords.length >= 0.6) return false;
  const front = page.slice(0, 2000);
  const labelled = [...front.matchAll(/\bdoi\s*[:：]\s*(?:https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[^\s"<>]+)/gi)]
    .map((match) => normalizeDoi(match[1]));
  return labelled.length > 0 && !labelled.includes(normalizeDoi(paper.doi));
}

async function fetchOpenPdf(paperId: string, ctx: JobCtx, pdfUrls: string[], doi: string | null, pmcid: string | null, lookupFailed = false): Promise<void> {
  ctx.progress(0.1, 'PDF 찾는 중');
  const candidates: (() => Promise<string | null>)[] = [
    ...pdfUrls.map((url) => async () => url),
    ...(doi ? [() => unpaywall.oaPdf(doi).catch(() => { lookupFailed = true; return null; })] : []),
    async () => (pmcid ? `https://europepmc.org/articles/${pmcid}?pdf=render` : null),
  ];
  let attempted = false;
  let identityMismatch = false;
  for (const next of candidates) {
    ctx.signal.throwIfAborted();
    const url = await next();
    if (!url) continue;
    attempted = true;
    ctx.progress(0.3, 'PDF 내려받는 중');
    const buf = await downloadPdf(url);
    if (!buf) continue;
    const tmp = join(PATHS.tmp, `candidate-${nanoid()}.pdf`);
    let extracted: ExtractionResult;
    try {
      writeFileSync(tmp, buf);
      extracted = await extractBlocks(tmp);
      ctx.signal.throwIfAborted();
      const paper = getPaper(paperId);
      if (!paper) throw new Error('논문을 찾을 수 없습니다');
      if (paper.pdf_file) {
        ctx.progress(1, '이미 PDF가 첨부되어 있습니다');
        return;
      }
      if (pdfIdentityConflict({ title: paper.title, doi: paper.doi ?? doi }, extracted)) {
        identityMismatch = true;
        continue;
      }
      renameSync(tmp, pdfPath(paperId));
    } catch (error) {
      ctx.signal.throwIfAborted();
      if (!getPaper(paperId)) throw error;
      continue;
    } finally {
      rmSync(tmp, { force: true });
    }
    await ingestPdf(paperId, ctx, extracted);
    return;
  }
  ctx.signal.throwIfAborted();
  if (identityMismatch) throw new Error('다른 논문으로 보이는 PDF를 제외했습니다 — 논문을 열어 올바른 PDF를 직접 첨부하세요');
  if (attempted) throw new Error('공개 PDF를 내려받지 못했습니다 — 논문을 열어 PDF를 직접 첨부하세요');
  ctx.progress(1, lookupFailed
    ? '메타데이터만 저장됨 — PDF 검색에 실패했습니다. 논문을 열어 PDF를 첨부하세요'
    : '메타데이터만 저장됨 — 공개 PDF를 찾지 못했습니다. 논문을 열어 PDF를 첨부하세요');
}

/** Retry OA discovery for an existing metadata-only paper, sharing any active import. */
export function retryPaperPdf(paperId: string): ImportResult {
  const paper = getPaper(paperId);
  if (!paper) throw new HttpError(404, '논문을 찾을 수 없습니다');
  const running = activeJob(paperId, 'import');
  if (running) return { paperId, duplicate: true, jobId: running.id };
  if (paper.pdf_file) return { paperId, duplicate: true };
  const jobId = startJob(paperId, 'import', async (ctx) => {
    ctx.progress(0.1, '공개 PDF 찾는 중');
    let work: openalex.OpenAlexWork | null = null;
    let lookupFailed = false;
    const attempt = async (fn: () => Promise<openalex.OpenAlexWork | null>) => {
      try { return await fn(); } catch { lookupFailed = true; return null; }
    };
    if (paper.openalex_id) work = await attempt(() => openalex.getById(paper.openalex_id!));
    if (!work && paper.doi) work = await attempt(() => openalex.getByDoi(paper.doi!));
    if (!work && paper.title) {
      const found = await attempt(() => openalex.search(paper.title));
      if (found && openalex.titleKey(found.title ?? found.display_name ?? '') === openalex.titleKey(paper.title)) work = found;
    }
    const summary = work ? openalex.toSummary(work) : null;
    const urls = work ? openAlexPdfUrls(work) : [];
    if (paper.arxiv_id) urls.push(`https://arxiv.org/pdf/${paper.arxiv_id}`);
    await fetchOpenPdf(paperId, ctx, urls, paper.doi ?? summary?.doi ?? null, paper.pmcid ?? summary?.pmcid ?? null, lookupFailed);
  });
  return { paperId, duplicate: true, jobId };
}


export interface ImportResult {
  paperId: string;
  jobId?: string;
  duplicate?: boolean;
}

/** Metadata is stored synchronously; PDF retrieval and extraction run in a job. */
export async function importFromInput(raw: string, field: FieldId | null): Promise<ImportResult> {
  const input = parseImportInput(raw);
  if (input.kind === 'openalex') {
    const existing = paperIdByOpenAlex(input.id);
    if (existing) return duplicateResult(existing);
    const work = await openalex.getById(input.id);
    if (!work) throw new HttpError(404, 'OpenAlex에서 논문을 찾지 못했습니다');
    const s = openalex.toSummary(work);
    if (!s.title) throw new HttpError(404, '논문 제목을 찾지 못했습니다');
    const duplicate = (s.doi && paperIdByDoi(s.doi)) || paperIdByOpenAlex(s.openalexId);
    if (duplicate) return duplicateResult(duplicate);
    const paperId = insertPaper({ title: s.title, authors: s.authors.map(splitName), year: s.year, journal: s.venue, abstract: s.abstract, doi: s.doi, openalex_id: s.openalexId, pmid: s.pmid, pmcid: s.pmcid, field });
    const jobId = startJob(paperId, 'import', (ctx) => fetchOpenPdf(paperId, ctx, openAlexPdfUrls(work), s.doi, s.pmcid));
    return { paperId, jobId };
  }
  const doi = input.kind === 'doi' ? input.doi : `10.48550/arxiv.${input.id}`.toLowerCase();
  const existing = paperIdByDoi(doi);
  if (existing) return duplicateResult(existing);

  if (input.kind === 'doi') {
    const found = await metadataForDoi(doi);
    if (!found) throw new HttpError(404, 'Crossref·OpenAlex에서 DOI를 찾지 못했습니다');
    const duplicate = paperIdByDoi(doi) ?? paperIdByOpenAlex(found.meta.openalex_id);
    if (duplicate) return duplicateResult(duplicate);
    const paperId = insertPaper({ ...found.meta, field });
    const jobId = startJob(paperId, 'import', (ctx) => fetchOpenPdf(paperId, ctx, found.pdfUrls, doi, found.meta.pmcid ?? null));
    return { paperId, jobId };
  }

  // arXiv: OpenAlex for metadata, arXiv API as fallback. The year comes from the arXiv id
  // (YYMM.*) because OpenAlex merges arXiv preprints with later records of other years.
  const id = input.id;
  const oa = await openalex.getByDoi(doi).catch(() => null);
  let meta: NewPaper;
  if (oa && (oa.title || oa.display_name)) {
    const s = openalex.toSummary(oa);
    meta = {
      title: s.title,
      authors: s.authors.map(splitName),
      year: arxivYear(id),
      journal: 'arXiv',
      abstract: s.abstract,
      openalex_id: s.openalexId,
    };
  } else {
    const ax = await arxiv.getById(id);
    if (!ax) throw new HttpError(404, 'arXiv에서 논문을 찾지 못했습니다');
    meta = { ...ax, year: arxivYear(id) };
  }
  const duplicate = paperIdByDoi(doi) ?? paperIdByOpenAlex(meta.openalex_id);
  if (duplicate) return duplicateResult(duplicate);
  const paperId = insertPaper({ ...meta, doi, arxiv_id: id, field });
  const jobId = startJob(paperId, 'import', (ctx) => fetchOpenPdf(paperId, ctx, [`https://arxiv.org/pdf/${id}`], doi, null));
  return { paperId, jobId };
}

/** One uploaded PDF: detect DOI or arXiv ID on pages 1–2, then extract in a job. */
export async function importUpload(fileName: string, data: Buffer, field: FieldId | null): Promise<ImportResult & { name: string }> {
  if (data.subarray(0, 4).toString('latin1') !== '%PDF') throw new HttpError(400, `PDF 파일이 아닙니다: ${fileName}`);
  const tmp = join(PATHS.tmp, `upload-${nanoid()}.pdf`);
  writeFileSync(tmp, data);
  try {
    const extracted = await extractBlocks(tmp);
    const text = extracted.blocks.filter((block) => block.page <= 2).map((block) => block.text).join('\n');
    const detectedDoi = findDoi(text);
    const arxivId = detectedDoi ? null : ARXIV_IN_TEXT.exec(text)?.[1] ?? null;
    const doi = detectedDoi ?? (arxivId ? `10.48550/arxiv.${arxivId}`.toLowerCase() : null);
    const title = extracted.title ?? fileName.replace(/\.pdf$/i, '');
    const dup = doi ? paperIdByDoi(doi) : null;
    if (dup) {
      rmSync(tmp, { force: true });
      return { name: fileName, paperId: dup, duplicate: true };
    }
    // Reserve the DOI before the asynchronous enrichment job starts, so overlapping uploads dedupe.
    const paperId = insertPaper({ title, doi, arxiv_id: arxivId, field });
    renameSync(tmp, pdfPath(paperId));
    const jobId = startJob(paperId, 'import', async (ctx) => {
      if (doi) {
        ctx.progress(0.2, '메타데이터 찾는 중');
        const found = await metadataForDoi(doi).catch(() => null);
        const m: NewPaper | null = found?.meta ?? (arxivId ? await arxiv.getById(arxivId).catch(() => null) : null);
        if (m && paperIdByDoi(doi) === paperId) {
          db.prepare(
            `UPDATE papers SET title=CASE WHEN title=? THEN ? ELSE title END, authors=?, year=?, journal=?, volume=?, issue=?, pages=?, doi=?, openalex_id=?, pmid=?, pmcid=?, abstract=?, updated_at=? WHERE id=?`,
          ).run(title, m.title, JSON.stringify(m.authors ?? []), m.year ?? null, m.journal ?? null, m.volume ?? null, m.issue ?? null, m.pages ?? null, doi, m.openalex_id ?? null, m.pmid ?? null, m.pmcid ?? null, m.abstract ?? null, now(), paperId);
        }
      }
      await ingestPdf(paperId, ctx, extracted);
    });
    return { name: fileName, paperId, jobId };
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Attach a PDF to an existing paper that has none. */
export function attachPdf(paperId: string, data: Buffer): string {
  const paper = getPaper(paperId);
  if (!paper) throw new HttpError(404, '논문을 찾을 수 없습니다');
  if (paper.pdf_file) throw new HttpError(409, '이미 PDF가 붙어 있습니다');
  const running = activeJob(paperId, 'import');
  if (running) return running.id;
  if (data.subarray(0, 4).toString('latin1') !== '%PDF') throw new HttpError(400, 'PDF 파일이 아닙니다');
  writeFileSync(pdfPath(paperId), data);
  return startJob(paperId, 'import', (ctx) => ingestPdf(paperId, ctx));
}
