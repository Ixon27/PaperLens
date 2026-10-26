import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const expand = (p: string) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const dbDir = expand(process.env.PAPER_READER_DB_DIR || '~/Library/Application Support/paper-reader');
const files = expand(process.env.PAPER_READER_FILES || '~/Desktop/MM/paper-reader');

export const PATHS = {
  root: repoRoot,
  db: join(dbDir, 'paper-reader.db'),
  files,
  pdfs: join(files, 'pdfs'),
  images: join(files, 'images'),
  tmp: join(files, 'tmp'),
  vault: expand(process.env.PAPER_READER_VAULT || '~/Obsidian/IXON_Vault'),
  prompts: join(repoRoot, 'prompts'),
  dist: join(repoRoot, 'dist'),
};

export const EMAIL = process.env.PAPER_READER_EMAIL?.trim() || null;
export const PORT = 4317;

for (const dir of [dbDir, PATHS.pdfs, PATHS.images, PATHS.tmp]) mkdirSync(dir, { recursive: true });

function findBinary(name: string, candidates: string[]): string | null {
  for (const c of candidates.map(expand)) if (existsSync(c)) return c;
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

export const BIN = {
  pdftotext: findBinary('pdftotext', ['/opt/homebrew/bin/pdftotext']),
  pdfinfo: findBinary('pdfinfo', ['/opt/homebrew/bin/pdfinfo']),
  claude: findBinary('claude', ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', '~/.local/bin/claude']),
  codex: findBinary('codex', ['~/.local/bin/codex', '/opt/homebrew/bin/codex']),
};

export const POPPLER_MISSING = 'poppler(pdftotext)가 없습니다: brew install poppler';
