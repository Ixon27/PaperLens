import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface StoragePaths {
  dbDir: string;
  files: string;
  vault: string | null;
}

/** Per-user storage, preserving a pre-desktop installation without moving or copying its papers. */
export function resolveStoragePaths({ env = process.env, home = homedir(), userData }: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  userData?: string;
} = {}): StoragePaths {
  const expand = (value: string) => value === '~' || value.startsWith('~/') ? join(home, value.slice(1)) : value;
  const dbDir = expand(env.PAPER_READER_DB_DIR || env.PAPER_READER_USER_DATA || userData || join(home, 'Library', 'Application Support', 'paper-reader'));
  const legacy = existsSync(join(dbDir, 'paper-reader.db'));
  const oldFiles = join(home, 'Desktop', 'MM', 'paper-reader');
  const newFiles = join(dbDir, 'files');
  const oldVault = join(home, 'Obsidian', 'IXON_Vault');
  return {
    dbDir,
    files: expand(env.PAPER_READER_FILES || (legacy && !existsSync(newFiles) && existsSync(oldFiles) ? oldFiles : newFiles)),
    vault: env.PAPER_READER_VAULT !== undefined
      ? env.PAPER_READER_VAULT.trim() ? expand(env.PAPER_READER_VAULT) : null
      : legacy && existsSync(oldVault) ? oldVault : null,
  };
}
