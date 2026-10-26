import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStoragePaths } from '../src/shared/storage';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'paper-reader-storage-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
const paths = () => resolveStoragePaths({ home, env: {} });

function legacyInstallation() {
  const dbDir = paths().dbDir;
  mkdirSync(dbDir, { recursive: true });
  writeFileSync(join(dbDir, 'paper-reader.db'), 'existing database');
  const files = join(home, 'Desktop', 'MM', 'paper-reader');
  const vault = join(home, 'Obsidian', 'IXON_Vault');
  mkdirSync(files, { recursive: true });
  mkdirSync(vault, { recursive: true });
  return { dbDir, files, vault };
}

describe('per-user storage', () => {
  it('does not adopt a legacy folder without an existing application database', () => {
    mkdirSync(join(home, 'Desktop', 'MM', 'paper-reader'), { recursive: true });
    mkdirSync(join(home, 'Obsidian', 'IXON_Vault'), { recursive: true });
    expect(paths().files).toBe(join(paths().dbDir, 'files'));
    expect(paths().vault).toBeNull();
  });

  it('keeps an existing database and its pre-desktop PDF and vault locations', () => {
    const existing = legacyInstallation();
    expect(paths()).toEqual(existing);
  });

  it('does not switch a new installation to an unrelated legacy folder on its second launch', () => {
    const old = legacyInstallation();
    const currentFiles = join(old.dbDir, 'files');
    mkdirSync(currentFiles);
    expect(paths().files).toBe(currentFiles);
  });

  it('honors explicit storage overrides and an explicitly disconnected vault', () => {
    legacyInstallation();
    const result = resolveStoragePaths({ home, env: {
      PAPER_READER_DB_DIR: '~/custom-db', PAPER_READER_FILES: '~/custom-pdfs', PAPER_READER_VAULT: '',
    } });
    expect(result).toEqual({ dbDir: join(home, 'custom-db'), files: join(home, 'custom-pdfs'), vault: null });
  });
});
