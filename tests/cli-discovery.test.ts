import { expect, it } from 'vitest';
import { discoverCliLocation, type CliDiscoveryContext } from '../src/server/cli-discovery';

function fixture(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, executableFiles: string[]): CliDiscoveryContext {
  const files = new Set(executableFiles.map(file => platform === 'win32' ? file.toLowerCase() : file));
  return { platform, home: platform === 'win32' ? 'C:\\Users\\reader' : '/Users/reader', env, isExecutable: file => files.has(platform === 'win32' ? file.toLowerCase() : file) };
}

it('macOS PATH order wins over old fixed Homebrew and local installers', () => {
  const context = fixture('darwin', { PATH: '/custom/current:/opt/homebrew/bin:/usr/local/bin' }, ['/custom/current/claude', '/opt/homebrew/bin/claude', '/Users/reader/.local/bin/claude']);
  expect(discoverCliLocation('claude', context)).toEqual({ path: '/custom/current/claude', source: 'path' });
});

it('macOS ignores non-executable or missing candidates and uses a deterministic GUI fallback', () => {
  const context = fixture('darwin', { PATH: '/missing:/not-executable' }, ['/Users/reader/.local/bin/codex', '/opt/homebrew/bin/codex']);
  expect(discoverCliLocation('codex', context)).toEqual({ path: '/Users/reader/.local/bin/codex', source: 'fallback' });
});

it('Windows PATH order and PATHEXT choose the current CLI before old native installers', () => {
  const context = fixture('win32', { PATH: '"C:\\Current CLI";C:\\Other', PATHEXT: '.CMD;.EXE' }, ['C:\\Current CLI\\codex.cmd', 'C:\\Current CLI\\codex.exe', 'C:\\Other\\codex.exe', 'C:\\Users\\reader\\.local\\bin\\codex.exe']);
  expect(discoverCliLocation('codex', context)).toEqual({ path: 'C:\\Current CLI\\codex.cmd', source: 'path' });
});

it('Windows GUI launch finds npm shims without a shell PATH', () => {
  const context = fixture('win32', { APPDATA: 'D:\\Roaming' }, ['D:\\Roaming\\npm\\claude.cmd']);
  expect(discoverCliLocation('claude', context)).toEqual({ path: 'D:\\Roaming\\npm\\claude.cmd', source: 'fallback' });
});

it.each(['darwin', 'win32'] as const)('honors explicit Codex install directories after PATH on %s', platform => {
  const dir = platform === 'win32' ? 'D:\\Codex' : '/custom/codex';
  const file = platform === 'win32' ? 'D:\\Codex\\codex.exe' : '/custom/codex/codex';
  expect(discoverCliLocation('codex', fixture(platform, { CODEX_INSTALL_DIR: dir }, [file]))).toEqual({ path: file, source: 'install-dir' });
});

it('never searches the working directory through empty or relative PATH entries', () => {
  expect(discoverCliLocation('claude', fixture('win32', { PATH: ';.;relative' }, ['claude.exe', 'relative\\claude.exe']))).toBeNull();
});
