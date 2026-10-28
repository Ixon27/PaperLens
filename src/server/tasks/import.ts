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

export type ImportInput = { kind: 'doi'; doi: string } | { kind: 'arxiv'; id: string };

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
    throw new HttpError(400, 'DOI나 arXiv 링크가 아닙니다');
  }
  const arxivDoi = ARXIV_DOI.exec(input);
  if (arxivDoi) return { kind: 'arxiv', id: arxivDoi[1] };
  const doi = findDoi(input);
  if (doi) return { kind: 'doi', doi };
  const ax = ARXIV_ID.exec(input);
  if (ax) return { kind: 'arxiv', id: ax[1] };
  throw new HttpError(400, 'DOI나 arXiv 링크가 아닙니다');
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

const pdfPath = (paperId: string) => join(PATHS.pdfs, `${paperId}.pdf`);

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
  ctx.progress(1, result.blocks.length ? `${result.pageCount}쪽 · 문단 ${paragraphs}개` : '텍스트 레이어가 없는 PDF(스캔본)입니다 — AI 기능을 쓸 수 없습니다');
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
  const pdfUrls = [...new Set([oa?.best_oa_location?.pdf_url, ...(oa?.locations ?? []).map((location) => location.pdf_url)].filter((url): url is string => !!url))];
  return { meta, pdfUrls };
}

export interface ImportResult {
  paperId: string;
  jobId?: string;
  duplicate?: boolean;
}

/** DOI / arXiv import: metadata synchronously (so the paper exists for navigation), PDF in a job. */
export async function importFromInput(raw: string, field: FieldId | null): Promise<ImportResult> {
  const input = parseImportInput(raw);
  const doi = input.kind === 'doi' ? input.doi : `10.48550/arxiv.${input.id}`.toLowerCase();
  const existing = paperIdByDoi(doi);
  if (existing) return { paperId: existing, duplicate: true };

  if (input.kind === 'doi') {
    const found = await metadataForDoi(doi);
    if (!found) throw new HttpError(404, 'Crossref·OpenAlex에서 DOI를 찾지 못했습니다');
    const duplicate = paperIdByDoi(doi); // another request may have imported it during the metadata fetch
    if (duplicate) return { paperId: duplicate, duplicate: true };
    const paperId = insertPaper({ ...found.meta, field });
    const pmcid = found.meta.pmcid;
    const jobId = startJob(paperId, 'import', async (ctx) => {
      ctx.progress(0.1, 'PDF 찾는 중');
      const candidates: (() => Promise<string | null>)[] = [
        ...found.pdfUrls.map((url) => async () => url),
        () => unpaywall.oaPdf(doi).catch(() => null),
        async () => (pmcid ? `https://europepmc.org/articles/${pmcid}?pdf=render` : null),
      ];
      for (const next of candidates) {
        ctx.signal.throwIfAborted();
        const url = await next();
        if (!url) continue;
        ctx.progress(0.3, 'PDF 내려받는 중');
        const buf = await downloadPdf(url);
        if (!buf) continue;
        writeFileSync(pdfPath(paperId), buf);
        await ingestPdf(paperId, ctx);
        return;
      }
      ctx.progress(1, '오픈액세스 PDF를 찾지 못했습니다 — PDF를 끌어다 놓아 붙이세요');
    });
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
  const duplicate = paperIdByDoi(doi);
  if (duplicate) return { paperId: duplicate, duplicate: true };
  const paperId = insertPaper({ ...meta, doi, arxiv_id: id, field });
  const jobId = startJob(paperId, 'import', async (ctx) => {
    ctx.progress(0.2, 'PDF 내려받는 중');
    const buf = await downloadPdf(`https://arxiv.org/pdf/${id}`);
    if (!buf) throw new Error('arXiv PDF를 내려받지 못했습니다');
    writeFileSync(pdfPath(paperId), buf);
    await ingestPdf(paperId, ctx);
  });
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
            `UPDATE papers SET title=?, authors=?, year=?, journal=?, volume=?, issue=?, pages=?, doi=?, openalex_id=?, pmid=?, pmcid=?, abstract=?, updated_at=? WHERE id=?`,
          ).run(m.title, JSON.stringify(m.authors ?? []), m.year ?? null, m.journal ?? null, m.volume ?? null, m.issue ?? null, m.pages ?? null, doi, m.openalex_id ?? null, m.pmid ?? null, m.pmcid ?? null, m.abstract ?? null, now(), paperId);
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
