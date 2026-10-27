import { realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { pageCiteRe } from '../../shared/cite';
import { mapOutsideBlocks, tidyForVault } from './tidy';

export interface ExportAuthor {
  family: string;
  given?: string;
}

export const RESEARCH_TYPE_LABELS: Record<string, string> = {
  wetlab: '실험실 측정(wet-lab)',
  omics: '오믹스·계산·생물정보',
  review: '리뷰·메타분석',
  clinical: '임상·코호트·역학',
};

export function citekey(p: { authors: ExportAuthor[]; year: number | null }): string {
  const fam = p.authors[0]?.family ?? '';
  const ascii = fam
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z]/g, '');
  return (ascii || 'Unknown') + (p.year ?? 'nd');
}

const initials = (given?: string) =>
  (given ?? '')
    .split(/[\s.\-]+/)
    .filter(Boolean)
    .map((s) => s[0].toUpperCase())
    .join('');

export function authorsLine(authors: ExportAuthor[]): string {
  return authors.map((a) => [a.family, initials(a.given)].filter(Boolean).join(' ')).join(', ');
}

export function journalLine(p: { journal: string | null; volume: string | null; issue: string | null; pages: string | null }): string {
  let s = p.journal ?? '';
  let vol = p.volume ?? '';
  if (p.issue) vol += `(${p.issue})`;
  if (p.pages) vol += `:${p.pages}`;
  if (vol) s = s ? `${s} ${vol}` : vol;
  return s;
}

const isUnder = (child: string, parent: string) => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !r.startsWith(sep) && !/^[A-Za-z]:/.test(r));
};
const toPosix = (p: string) => p.split(sep).join('/');

/** Vault-relative link path of the paper's PDF, or null when the PDF dir is outside the vault. */
export function pdfVaultPath(paperId: string, pdfsDir: string, vault: string): string | null {
  let pdfs: string;
  let vaultReal: string;
  try {
    pdfs = realpathSync(pdfsDir);
    vaultReal = realpathSync(vault);
  } catch {
    return null;
  }
  let mm: string | null = null;
  try {
    mm = realpathSync(vault + '/MM');
  } catch {
    mm = null;
  }
  if (mm && isUnder(pdfs, mm)) {
    const rel = toPosix(relative(mm, pdfs));
    return ['MM', rel, `${paperId}.pdf`].filter(Boolean).join('/');
  }
  if (isUnder(pdfs, vaultReal)) {
    const rel = toPosix(relative(vaultReal, pdfs));
    return [rel, `${paperId}.pdf`].filter(Boolean).join('/');
  }
  return null;
}

export function pageLink(pdfPath: string | null, page: number, end?: number): string {
  const label = `p.${page}${end ? '–' + end : ''}`;
  return pdfPath ? `[[${pdfPath}#page=${page}|${label}]]` : `(${label})`;
}

export function convertPageRefs(md: string, pdfPath: string | null): string {
  return md.replace(pageCiteRe(), (_m, a: string, b: string | undefined) =>
    pageLink(pdfPath, Number(a), b ? Number(b) : undefined),
  );
}

export function shiftHeadings(md: string): string {
  return mapOutsideBlocks(md, (line) => {
    const m = /^(#{4,6})(\s.*)$/.exec(line);
    return m ? '#'.repeat(m[1].length - 2) + m[2] : line;
  });
}

const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function localDate(d = new Date()): string {
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

export interface NoteHighlight {
  id: string;
  type: 'text' | 'area';
  page: number;
  y: number;
  text: string | null;
  note: string | null;
  /** Vault attachment file name (area highlights with an image). */
  attachment: string | null;
}

export interface NoteInput {
  paper: {
    title: string;
    authors: ExportAuthor[];
    year: number | null;
    journal: string | null;
    volume: string | null;
    issue: string | null;
    pages: string | null;
    doi: string | null;
    researchTypes: string[];
  };
  tags: string[];
  analysis: string | null;
  engine: string | null;
  pdfPath: string | null;
  highlights: NoteHighlight[];
  relatedNotes: string[];
  date?: string;
}

export function attachmentName(key: string, highlightId: string): string {
  return `${key}-${highlightId.slice(0, 8)}.png`;
}

export function buildNote(n: NoteInput): string {
  const p = n.paper;
  const date = n.date ?? localDate();
  const key = citekey(p);
  const fm: string[] = ['---', `tags: [${['paper', ...n.tags.filter((t) => t !== 'paper')].join(', ')}]`, `created: ${date}`];
  const authors = authorsLine(p.authors);
  if (authors) fm.push(`authors: ${q(authors)}`);
  if (p.year != null) fm.push(`year: ${p.year}`);
  fm.push(`title: ${q(p.title)}`);
  const journal = journalLine(p);
  if (journal) fm.push(`journal: ${q(journal)}`);
  if (p.doi) fm.push(`doi: ${p.doi}`);
  fm.push(`citekey: ${key}`, 'status: reading', 'source: paper-reader', '---');

  const fam = p.authors[0]?.family;
  const heading = [fam, p.year].filter((x) => x != null && x !== '').join(' ');
  const out: string[] = [fm.join('\n'), '', `# ${p.title}${heading ? ` (${heading})` : ''}`, ''];
  const labels = p.researchTypes.map((t) => RESEARCH_TYPE_LABELS[t] ?? t).join(', ');
  out.push(`> paper-reader에서 내보냄 · ${date} · 엔진 ${n.engine ?? '-'} · 연구 유형 ${labels || '-'}`, '');
  if (n.pdfPath) out.push(`원문 PDF: [[${n.pdfPath}|PDF]]`, '');
  if (n.analysis?.trim()) out.push(tidyForVault(convertPageRefs(shiftHeadings(n.analysis), n.pdfPath)), '');

  if (n.highlights.length) {
    out.push('## 하이라이트·메모');
    const sorted = [...n.highlights].sort((a, b) => a.page - b.page || a.y - b.y);
    let page = -1;
    for (const h of sorted) {
      if (h.page !== page) {
        page = h.page;
        out.push('', `### p.${page}`);
      }
      const note = h.note?.trim() ? ` — ${h.note.trim().replace(/\s*\n\s*/g, ' ')}` : '';
      const link = pageLink(n.pdfPath, h.page);
      if (h.type === 'area') {
        const body = h.attachment ? `![[${h.attachment}|400]]` : '(영역)';
        out.push(`- ${body} ${link}${note}`);
      } else {
        out.push(`- "${(h.text ?? '').replace(/\s+/g, ' ').trim()}" ${link}${note}`);
      }
    }
    out.push('');
  }

  out.push('## 관련 노트');
  for (const r of n.relatedNotes) out.push(`- [[${r}]]`);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
