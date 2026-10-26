import { execFile } from 'node:child_process';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { nanoid } from 'nanoid';
import { BIN, PATHS, POPPLER_MISSING } from '../config';
import { db, getPaper, now, refreshFts, tx, type Author } from '../db';
import { HttpError } from '../http-error';
import { activeJob, startJob, type JobCtx } from '../jobs';
import { extractBlocks } from '../pdf/extract';
import * as arxiv from '../services/arxiv';
import * as crossref from '../services/crossref';
import { getBuffer } from '../services/http';
import * as openalex from '../services/openalex';
import * as unpaywall from '../services/unpaywall';

const execFileP = promisify(execFile);

export type ImportInput = { kind: 'doi'; doi: string } | { kind: 'arxiv'; id: string };

const DOI_RE = /10\.\d{4,9}\/[^\s"<>]+/i;

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
  const doi = findDoi(input);
  if (doi) return { kind: 'doi', doi };
  const ax = /(?:arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5})(v\d+)?/i.exec(input);
  if (ax) return { kind: 'arxiv', id: ax[1] };
  throw new HttpError(400, 'DOI나 arXiv 링크가 아닙니다');
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
}

function insertPaper(p: NewPaper): string {
  const id = nanoid(10);
  const t = now();
  db.prepare(
    `INSERT INTO papers(id,title,authors,year,journal,volume,issue,pages,doi,arxiv_id,openalex_id,pmid,pmcid,abstract,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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

/** Extract text blocks from the paper's PDF into `blocks`, `page_count` and FTS. */
export async function ingestPdf(paperId: string, ctx: JobCtx): Promise<void> {
  ctx.progress(0.7, '텍스트 추출 중');
  const { pageCount, blocks } = await extractBlocks(pdfPath(paperId));
  tx(() => {
    db.prepare('DELETE FROM translations WHERE paper_id=?').run(paperId);
    db.prepare('DELETE FROM blocks WHERE paper_id=?').run(paperId);
    const ins = db.prepare('INSERT INTO blocks(paper_id,idx,page,text,lines,page_w,page_h,is_ref) VALUES(?,?,?,?,?,?,?,?)');
    for (const b of blocks) ins.run(paperId, b.idx, b.page, b.text, JSON.stringify(b.lines), b.pageW, b.pageH, b.isRef ? 1 : 0);
    db.prepare('UPDATE papers SET pdf_file=?, page_count=?, updated_at=? WHERE id=?').run(`${paperId}.pdf`, pageCount, now(), paperId);
  });
  refreshFts(paperId);
  ctx.progress(1, blocks.length ? `${pageCount}쪽 · 문단 ${blocks.length}개` : '텍스트 레이어가 없는 PDF(스캔본)입니다 — AI 기능을 쓸 수 없습니다');
}

async function downloadPdf(url: string): Promise<Buffer | null> {
  try {
    const buf = await getBuffer(url);
    return buf && buf.subarray(0, 4).toString('latin1') === '%PDF' ? buf : null;
  } catch {
    return null;
  }
}

/** Fill metadata from Crossref + OpenAlex for a DOI (null when Crossref has no record). */
async function metadataForDoi(doi: string): Promise<{ meta: NewPaper; oaPdf: string | null } | null> {
  const [cr, oa] = await Promise.all([crossref.getWork(doi), openalex.getByDoi(doi).catch(() => null)]);
  if (!cr) return null;
  const s = oa ? openalex.toSummary(oa) : null;
  return {
    meta: { ...cr, doi, openalex_id: s?.openalexId ?? null, pmid: s?.pmid ?? null, pmcid: s?.pmcid ?? null, abstract: cr.abstract ?? s?.abstract ?? null },
    oaPdf: s?.oaPdf ?? null,
  };
}

export interface ImportResult {
  paperId: string;
  jobId?: string;
  duplicate?: boolean;
}

/** DOI / arXiv import: metadata synchronously (so the paper exists for navigation), PDF in a job. */
export async function importFromInput(raw: string): Promise<ImportResult> {
  if (!BIN.pdftotext) throw new HttpError(500, POPPLER_MISSING);
  const input = parseImportInput(raw);
  const doi = input.kind === 'doi' ? input.doi : `10.48550/arxiv.${input.id}`.toLowerCase();
  const existing = paperIdByDoi(doi);
  if (existing) return { paperId: existing, duplicate: true };

  if (input.kind === 'doi') {
    const found = await metadataForDoi(doi);
    if (!found) throw new HttpError(404, 'Crossref에서 DOI를 찾지 못했습니다');
    const duplicate = paperIdByDoi(doi); // another request may have imported it during the metadata fetch
    if (duplicate) return { paperId: duplicate, duplicate: true };
    const paperId = insertPaper(found.meta);
    const pmcid = found.meta.pmcid;
    const jobId = startJob(paperId, 'import', async (ctx) => {
      ctx.progress(0.1, 'PDF 찾는 중');
      const candidates: (() => Promise<string | null>)[] = [
        async () => found.oaPdf,
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
      year: 2000 + parseInt(id.slice(0, 2), 10),
      journal: 'arXiv',
      abstract: s.abstract,
      openalex_id: s.openalexId,
    };
  } else {
    const ax = await arxiv.getById(id);
    if (!ax) throw new HttpError(404, 'arXiv에서 논문을 찾지 못했습니다');
    meta = { ...ax };
  }
  const duplicate = paperIdByDoi(doi);
  if (duplicate) return { paperId: duplicate, duplicate: true };
  const paperId = insertPaper({ ...meta, doi, arxiv_id: id });
  const jobId = startJob(paperId, 'import', async (ctx) => {
    ctx.progress(0.2, 'PDF 내려받는 중');
    const buf = await downloadPdf(`https://arxiv.org/pdf/${id}`);
    if (!buf) throw new Error('arXiv PDF를 내려받지 못했습니다');
    writeFileSync(pdfPath(paperId), buf);
    await ingestPdf(paperId, ctx);
  });
  return { paperId, jobId };
}

async function pdfInfoTitle(file: string): Promise<string | null> {
  if (!BIN.pdfinfo) return null;
  try {
    const { stdout } = await execFileP(BIN.pdfinfo, [file]);
    const title = /^Title:\s*(.*)$/m.exec(stdout)?.[1]?.trim();
    return title && title.length >= 15 ? title : null;
  } catch {
    return null;
  }
}

async function firstPagesText(file: string): Promise<string> {
  if (!BIN.pdftotext) throw new HttpError(500, POPPLER_MISSING);
  const { stdout } = await execFileP(BIN.pdftotext, ['-f', '1', '-l', '2', file, '-'], { maxBuffer: 64 << 20 });
  return stdout;
}

/** One uploaded PDF: detect DOI on pages 1–2 (duplicate check), create the paper, extract in a job. */
export async function importUpload(fileName: string, data: Buffer): Promise<ImportResult & { name: string }> {
  if (data.subarray(0, 4).toString('latin1') !== '%PDF') throw new HttpError(400, `PDF 파일이 아닙니다: ${fileName}`);
  const tmp = join(PATHS.tmp, `upload-${nanoid()}.pdf`);
  writeFileSync(tmp, data);
  try {
    const doi = findDoi(await firstPagesText(tmp));
    const title = (await pdfInfoTitle(tmp)) ?? fileName.replace(/\.pdf$/i, '');
    const dup = doi ? paperIdByDoi(doi) : null;
    if (dup) {
      rmSync(tmp, { force: true });
      return { name: fileName, paperId: dup, duplicate: true };
    }
    // Reserve the DOI before the asynchronous enrichment job starts, so overlapping uploads dedupe.
    const paperId = insertPaper({ title, doi });
    renameSync(tmp, pdfPath(paperId));
    const jobId = startJob(paperId, 'import', async (ctx) => {
      if (doi) {
        ctx.progress(0.2, '메타데이터 찾는 중');
        const found = await metadataForDoi(doi).catch(() => null);
        if (found && paperIdByDoi(doi) === paperId) {
          const m = found.meta;
          db.prepare(
            `UPDATE papers SET title=?, authors=?, year=?, journal=?, volume=?, issue=?, pages=?, doi=?, openalex_id=?, pmid=?, pmcid=?, abstract=?, updated_at=? WHERE id=?`,
          ).run(m.title, JSON.stringify(m.authors ?? []), m.year ?? null, m.journal ?? null, m.volume ?? null, m.issue ?? null, m.pages ?? null, doi, m.openalex_id ?? null, m.pmid ?? null, m.pmcid ?? null, m.abstract ?? null, now(), paperId);
        }
      }
      await ingestPdf(paperId, ctx);
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
  if (!BIN.pdftotext) throw new HttpError(500, POPPLER_MISSING);
  writeFileSync(pdfPath(paperId), data);
  return startJob(paperId, 'import', (ctx) => ingestPdf(paperId, ctx));
}
