import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStoragePaths } from '../shared/storage';

import { discoverCliLocation } from './cli-discovery';
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

/** Resolved afresh so installation and PATH changes never leave a saved executable behind. */
export function discoverCli(engine: 'claude' | 'codex') {
  return discoverCliLocation(engine, {
    platform: process.platform,
    home: homedir(),
    env: process.env,
    isExecutable: path => {
      try {
        if (!statSync(path).isFile()) return false;
        accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return true;
      } catch { return false; }
    },
  });
}

export const BIN = {
  get claude() { return discoverCli('claude')?.path ?? null; },
  get codex() { return discoverCli('codex')?.path ?? null; },
};

