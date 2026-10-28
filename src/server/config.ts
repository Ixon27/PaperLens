import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStoragePaths } from '../shared/storage';

const expand = (p: string) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p);
const repoRoot = process.env.PAPER_READER_APP_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { dbDir, files, vault } = resolveStoragePaths();

export const PATHS = {
  root: repoRoot,
  db: join(dbDir, 'paper-reader.db'),
  files,
  pdfs: join(files, 'pdfs'),
  images: join(files, 'images'),
  tmp: join(files, 'tmp'),
  vault,
  prompts: join(repoRoot, 'prompts'),
  dist: join(repoRoot, 'dist'),
};

export const EMAIL = process.env.PAPER_READER_EMAIL?.trim() || null;
export const PORT = 4317;

for (const dir of [dbDir, PATHS.pdfs, PATHS.images, PATHS.tmp]) mkdirSync(dir, { recursive: true });

/** File names a command can have on this platform (Windows resolves `claude` to `claude.exe`/`claude.cmd`). */
function executableNames(name: string): string[] {
  if (process.platform !== 'win32') return [name];
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean);
  return exts.map((ext) => name + ext.toLowerCase());
}

function findBinary(name: string, candidates: string[]): string | null {
  for (const c of candidates.map(expand)) if (existsSync(c)) return c;
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const file of executableNames(name)) if (existsSync(join(dir, file))) return join(dir, file);
  }
  return null;
}

/** Where the official installers put each CLI, for apps started without the user's shell PATH. */
const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
const CANDIDATES = process.platform === 'win32'
  ? {
      claude: [join(homedir(), '.local', 'bin', 'claude.exe'), join(appData, 'npm', 'claude.cmd')],
      codex: [process.env.CODEX_INSTALL_DIR ? join(process.env.CODEX_INSTALL_DIR, 'codex.exe') : '', join(appData, 'npm', 'codex.cmd'), join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'), join(homedir(), '.local', 'bin', 'codex.exe')],
    }
  : {
      claude: ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', '~/.local/bin/claude'],
      codex: [process.env.CODEX_INSTALL_DIR ? join(process.env.CODEX_INSTALL_DIR, 'codex') : '', '~/.local/bin/codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex'],
    };

export const BIN = {
  get claude() { return findBinary('claude', CANDIDATES.claude); },
  get codex() { return findBinary('codex', CANDIDATES.codex); },
};

