import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { resolveCli } from '../src/server/llm/command';

// What `npm install -g @openai/codex` writes on Windows (cmd-shim).
const SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'paper-reader-cli-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('runs an npm .cmd shim as its script under Node, never through cmd.exe', () => {
  const bin = join(dir, 'codex.cmd');
  writeFileSync(bin, SHIM);
  writeFileSync(join(dir, 'node.exe'), '');
  expect(resolveCli(bin, 'win32')).toEqual({
    command: join(dir, 'node.exe'),
    args: [join(dir, 'node_modules\\@openai\\codex\\bin\\codex.js')],
    env: {},
  });
});

it('runs the native executable targeted by a current Claude npm shim', () => {
  const bin = join(dir, 'claude.cmd');
  writeFileSync(bin, '@echo off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n');
  expect(resolveCli(bin, 'win32')).toEqual({
    command: join(dir, 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'),
    args: [],
    env: {},
  });
});

it('starts native executables and non-Windows binaries as they are', () => {
  expect(resolveCli('C:\\Users\\me\\.local\\bin\\claude.exe', 'win32')).toEqual({ command: 'C:\\Users\\me\\.local\\bin\\claude.exe', args: [], env: {} });
  expect(resolveCli('/opt/homebrew/bin/claude', 'darwin')).toEqual({ command: '/opt/homebrew/bin/claude', args: [], env: {} });
});

it('refuses a .cmd file that is not an npm shim', () => {
  const bin = join(dir, 'claude.cmd');
  writeFileSync(bin, '@echo off\r\nclaude-real %*\r\n');
  expect(() => resolveCli(bin, 'win32')).toThrow('CLI 실행 파일을 해석하지 못했습니다');
});
