import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { Hono } from 'hono';
import { PATHS } from '../config';
import { db, getArtifact, getPaper, parseAuthors, type PaperRow } from '../db';
import { attachmentName, buildNote, citekey, pdfVaultPath, type NoteHighlight } from '../export/obsidian';
import { HttpError } from '../http-error';
import { imagePath } from '../images';
import { runLlm } from '../llm';
import { abstractOrPageOne } from '../pdf/context';
import { fill, loadPrompt } from '../prompts';

export const exportRoutes = new Hono();

const PAPERS_DIR = () => join(PATHS.vault, '04_References', 'Papers');
const STOPWORDS: Record<string, true> = Object.fromEntries('a an the of in on for and to with by from via using'.split(' ').map((w) => [w, true]));
const SKIP_DIRS: Record<string, true> = { '.git': true, '.obsidian': true, '.trash': true, MM: true };

function requirePaper(id: string): PaperRow {
  const p = getPaper(id);
  if (!p) throw new HttpError(404, '논문을 찾을 수 없습니다');
  return p;
}

function walkMd(dir: string, recursive: boolean, skip?: Record<string, true>): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (skip?.[e.name] === true) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (recursive) out.push(...walkMd(full, true, skip));
    } else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

const normalize = (s: string) => s.replace(/[-_]/g, ' ').toLowerCase();

function fallbackSlug(title: string): string {
  return title
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z0-9-]/g, ''))
    .filter((w) => w && STOPWORDS[w.toLowerCase()] !== true)
    .slice(0, 4)
    .join('-');
}

function sanitizeSlug(s: string): string {
  return s
    .replace(/[^A-Za-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/-$/, '');
}

function sanitizeTags(line: string): string[] {
  return line
    .split(',')
    .map((t) =>
      t
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9가-힣-]/g, ''),
    )
    .filter(Boolean)
    .slice(0, 6);
}

exportRoutes.post('/papers/:id/export/preview', async (c) => {
  const paper = requirePaper(c.req.param('id'));
  const key = citekey({ authors: parseAuthors(paper), year: paper.year });
  let slug = '';
  let tags: string[] = [];
  try {
    const P = loadPrompt('export');
    const res = await runLlm({ system: '', prompt: fill(P.SLUG, { title: paper.title, abstract: abstractOrPageOne(paper) }), profile: 'quick' });
    const lines = res
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    slug = sanitizeSlug(lines[0] ?? '');
    tags = sanitizeTags(lines[1] ?? '');
  } catch {
    slug = '';
    tags = [];
  }
  if (!slug) slug = sanitizeSlug(fallbackSlug(paper.title));
  const filename = `${key}${slug ? '-' + slug : ''}.md`;

  const analysis = getArtifact(paper.id, 'analysis')?.content ?? '';
  const haystack = normalize(analysis + '\n' + paper.title);
  const notes = [
    ...walkMd(join(PATHS.vault, '04_References', 'Notes'), true),
    ...walkMd(PAPERS_DIR(), false),
  ];
  const seen = new Set<string>();
  const candidates: { name: string; needle: string }[] = [];
  for (const f of notes) {
    const name = basename(f, '.md');
    if (name === basename(filename, '.md') || seen.has(name)) continue;
    seen.add(name);
    const needle = normalize(name);
    if (needle.length >= 4 && haystack.includes(needle)) candidates.push({ name, needle });
  }
  candidates.sort((a, b) => b.needle.length - a.needle.length);

  return c.json({
    filename,
    tags,
    relatedSuggestions: candidates.slice(0, 10).map((x) => x.name),
    exists: existsSync(join(PAPERS_DIR(), filename)),
    hasAnalysis: !!analysis.trim(),
  });
});

interface HighlightRow {
  id: string;
  type: 'text' | 'area';
  position: string;
  text: string | null;
  image_file: string | null;
  note: string | null;
}

exportRoutes.post('/papers/:id/export', async (c) => {
  const paper = requirePaper(c.req.param('id'));
  const body = await c.req.json<{ filename?: string; tags?: string[]; relatedNotes?: string[]; overwrite?: boolean }>();
  const filename = (body.filename ?? '').trim();
  if (!filename.endsWith('.md') || filename.length <= 3 || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    throw new HttpError(400, '파일 이름은 .md 로 끝나야 하고 / 나 .. 를 포함할 수 없습니다');
  }
  const target = join(PAPERS_DIR(), filename);
  const clash = walkMd(PATHS.vault, true, SKIP_DIRS).find((f) => basename(f) === filename && f !== target);
  if (clash) throw new HttpError(409, `볼트에 같은 이름의 노트가 이미 있습니다: ${relative(PATHS.vault, clash)}`);
  if (existsSync(target) && !body.overwrite) throw new HttpError(409, '이미 있습니다 — 덮어쓰기를 체크하세요');

  const authors = parseAuthors(paper);
  const key = citekey({ authors, year: paper.year });
  const art = getArtifact(paper.id, 'analysis');
  let researchTypes: string[] = [];
  if (art) {
    const meta = JSON.parse(art.meta) as { types?: string[] };
    researchTypes = meta.types ?? [];
  }
  if (!researchTypes.length && paper.research_types) researchTypes = JSON.parse(paper.research_types) as string[];

  const rows = db
    .prepare('SELECT id,type,position,text,image_file,note FROM highlights WHERE paper_id=?')
    .all(paper.id) as unknown as HighlightRow[];
  const attachDir = join(PATHS.vault, 'Attachments', 'paper-reader');
  const copies: [string, string][] = [];
  const highlights: NoteHighlight[] = rows.map((h) => {
    const pos = JSON.parse(h.position) as { boundingRect?: { pageNumber?: number; y1?: number } };
    let attachment: string | null = null;
    if (h.type === 'area' && h.image_file && existsSync(imagePath(h.image_file))) {
      attachment = attachmentName(key, h.id);
      copies.push([imagePath(h.image_file), join(attachDir, attachment)]);
    }
    return {
      id: h.id,
      type: h.type,
      page: pos.boundingRect?.pageNumber ?? 1,
      y: pos.boundingRect?.y1 ?? 0,
      text: h.text,
      note: h.note,
      attachment,
    };
  });

  const note = buildNote({
    paper: {
      title: paper.title,
      authors,
      year: paper.year,
      journal: paper.journal,
      volume: paper.volume,
      issue: paper.issue,
      pages: paper.pages,
      doi: paper.doi,
      researchTypes,
    },
    tags: (body.tags ?? []).map((t) => t.trim()).filter(Boolean),
    analysis: art?.content ?? null,
    engine: art?.engine ?? null,
    pdfPath: paper.pdf_file ? pdfVaultPath(paper.id, PATHS.pdfs, PATHS.vault) : null,
    highlights,
    relatedNotes: (body.relatedNotes ?? []).map((r) => r.trim()).filter(Boolean),
  });

  mkdirSync(PAPERS_DIR(), { recursive: true });
  writeFileSync(target, note, 'utf8');
  if (copies.length) mkdirSync(attachDir, { recursive: true });
  for (const [from, to] of copies) copyFileSync(from, to);
  return c.json({ path: target });
});
