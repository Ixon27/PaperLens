import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { BIN } from './config';
import { spawnCli, stopCli } from './llm/command';
import type { Engine } from './settings';

type Operation = { kind: 'install' | 'login'; state: 'running' | 'success' | 'error' | 'cancelled'; message: string; codeNeeded: boolean; child: ChildProcessWithoutNullStreams | null; abort: AbortController; timer: ReturnType<typeof setTimeout> };
const operations = new Map<Engine, Operation>();

// These are the final HTTPS destinations of the providers' documented standalone installers.
// The installer itself verifies the downloaded release against the provider's manifest.
const INSTALLERS = {
  claude: { unix: 'https://downloads.claude.ai/claude-code-releases/bootstrap.sh', windows: 'https://downloads.claude.ai/claude-code-releases/bootstrap.ps1' },
  codex: { unix: 'https://releases.openai.com/codex/install.sh', windows: 'https://releases.openai.com/codex/install.ps1' },
} as const;
function supported() { return (process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux') && (process.arch === 'arm64' || process.arch === 'x64'); }

async function installerScript(engine: Engine, signal: AbortSignal): Promise<string> {
  const url = INSTALLERS[engine][process.platform === 'win32' ? 'windows' : 'unix'];
  const response = await fetch(url, { signal, redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('installer download failed');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) throw new Error('installer too large');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw new Error('empty installer');
  return Buffer.concat(chunks).toString('utf8');
}

function stopOperation(op: Operation) {
  if (!op.child) return;
  if (op.kind === 'install' && process.platform !== 'win32' && op.child.pid) {
    try { process.kill(-op.child.pid, 'SIGTERM'); return; } catch { /* Process may already have exited. */ }
  }
  stopCli(op.child);
}

export async function providerStatus(engine: Engine) {
  const op = operations.get(engine);
  const installed = !!BIN[engine];
  let auth: 'connected' | 'disconnected' | 'unknown' = 'unknown';
  if (installed && op?.state !== 'running') {
    try {
      const child = spawnCli(BIN[engine]!, engine === 'claude' ? ['auth', 'status'] : ['login', 'status'], {});
      child.stdin.end();
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { if (output.length < 8192) output += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { if (output.length < 8192) output += chunk.toString(); });
      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => { stopCli(child); resolve(null); }, 10000);
        child.once('error', () => { clearTimeout(timer); resolve(null); });
        child.once('close', (value) => { clearTimeout(timer); resolve(value); });
      });
      if (engine === 'claude') {
        try { const parsed = JSON.parse(output); if (typeof parsed.loggedIn === 'boolean') auth = parsed.loggedIn ? 'connected' : 'disconnected'; } catch { /* Unknown status. */ }
      } else if (code === 0) auth = 'connected';
      else if (code === 1 && /not logged in/i.test(output)) auth = 'disconnected';
    } catch { /* A broken CLI is not proof of a disconnected account. */ }
  }
  return { installed, auth, canInstall: supported(), operation: op ? { kind: op.kind, state: op.state, message: op.message, codeNeeded: op.codeNeeded } : null };
}

function attach(engine: Engine, op: Operation, child: ChildProcessWithoutNullStreams) {
  op.child = child;
  // Examine only the fixed prompt; never retain or return CLI output or login URLs.
  let prompt = '';
  const inspect = (chunk: Buffer) => {
    if (op.kind !== 'login' || engine !== 'claude') return;
    prompt = (prompt + chunk.toString()).slice(-256);
    if (/paste code here/i.test(prompt)) { op.codeNeeded = true; prompt = ''; }
  };
  child.stdout.on('data', inspect); child.stderr.on('data', inspect);
  child.stdin.on('error', () => {});
  child.once('error', () => { if (op.state === 'running') { op.state = 'error'; op.message = '작업을 시작하지 못했습니다. 공식 안내를 확인하세요.'; } clearTimeout(op.timer); });
  child.once('close', (code) => {
    clearTimeout(op.timer);
    if (op.state !== 'running') return;
    if (code === 0 && (op.kind !== 'install' || BIN[engine])) { op.state = 'success'; op.message = op.kind === 'login' ? '로그인 작업이 완료되었습니다. 연결 상태를 확인합니다.' : '설치가 완료되었습니다.'; }
    else { op.state = 'error'; op.message = op.kind === 'install' ? '설치하지 못했거나 설치된 CLI를 찾지 못했습니다. 공식 안내와 네트워크를 확인하세요.' : '로그인을 완료하지 못했습니다. 브라우저와 공식 안내를 확인하세요.'; }
  });
}

export function startProviderOperation(engine: Engine, kind: 'install' | 'login') {
  if (operations.get(engine)?.state === 'running') throw new Error('이미 작업이 진행 중입니다');
  if (kind === 'install' && BIN[engine]) throw new Error('CLI가 이미 설치되어 있습니다');
  if (kind === 'install' && !supported()) throw new Error('이 운영체제 또는 CPU의 자동 설치는 지원하지 않습니다. 공식 설치 안내를 이용하세요.');
  if (kind === 'login' && !BIN[engine]) throw new Error('먼저 CLI를 설치하세요');
  const abort = new AbortController();
  const op: Operation = { kind, state: 'running', message: kind === 'login' ? '브라우저에서 로그인을 완료하세요.' : '제공자의 공식 설치 프로그램으로 설치 중입니다.', codeNeeded: false, child: null, abort, timer: setTimeout(() => {
    if (op.state !== 'running') return;
    op.state = 'error'; op.message = '시간이 초과되었습니다. 공식 안내를 확인하고 다시 시도하세요.'; abort.abort(); stopOperation(op);
  }, kind === 'login' ? 300000 : 600000) };
  operations.set(engine, op);
  if (kind === 'login') {
    try {
      const child = spawnCli(BIN[engine]!, engine === 'claude' ? ['auth', 'login', '--claudeai'] : ['login'], {});
      attach(engine, op, child);
      if (engine === 'codex') child.stdin.end();
    } catch { op.state = 'error'; op.message = 'CLI를 실행하지 못했습니다. 공식 안내를 확인하세요.'; clearTimeout(op.timer); }
    return;
  }
  void (async () => {
    let dir: string | null = null;
    try {
      const script = await installerScript(engine, abort.signal);
      if (op.state !== 'running') return;
      dir = await mkdtemp(join(tmpdir(), 'paperlens-installer-'));
      const windows = process.platform === 'win32';
      const path = join(dir, windows ? 'install.ps1' : 'install.sh');
      await writeFile(path, script, { mode: 0o600, flag: 'wx' });
      if (abort.signal.aborted) { await rm(dir, { recursive: true, force: true }); return; }
      const child = spawn(windows ? 'powershell.exe' : '/bin/bash', windows ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path] : [path], {
        stdio: 'pipe', windowsHide: true, detached: !windows,
        env: { ...process.env, CODEX_NON_INTERACTIVE: '1', ...(windows ? {} : { PATH: `${join(homedir(), '.local', 'bin')}${delimiter}${process.env.PATH ?? ''}` }) },
      });
      const cleanup = dir;
      child.once('close', () => { void rm(cleanup, { recursive: true, force: true }); });
      attach(engine, op, child);
      child.stdin.end();
    } catch {
      if (dir) await rm(dir, { recursive: true, force: true });
      if (op.state === 'running') { op.state = 'error'; op.message = '공식 설치 프로그램을 내려받거나 실행하지 못했습니다. 네트워크와 공식 안내를 확인하세요.'; }
      clearTimeout(op.timer);
    }
  })();
}

export function submitProviderCode(engine: Engine, code: unknown) {
  const op = operations.get(engine);
  if (engine !== 'claude' || !op || op.state !== 'running' || !op.codeNeeded || !op.child || typeof code !== 'string' || !code.trim() || code.length > 2048 || /[\r\n]/.test(code)) throw new Error('인증 코드를 전달할 수 없습니다');
  op.child.stdin.write(code.trim() + '\n');
  op.codeNeeded = false;
}

export function cancelProviderOperation(engine: Engine) {
  const op = operations.get(engine);
  if (op?.state === 'running') { op.state = 'cancelled'; op.message = '취소했습니다. 이미 진행된 설치나 브라우저 인증은 별도로 확인하세요.'; clearTimeout(op.timer); op.abort.abort(); stopOperation(op); }
}
export function cancelProviderOperations() { cancelProviderOperation('claude'); cancelProviderOperation('codex'); }
