import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { BIN } from './config';
import { spawnCli, stopCli } from './llm/command';
import { saveSettings, type Engine } from './settings';

type Operation = { kind: 'connect'; phase: 'install' | 'login'; state: 'running' | 'success' | 'error' | 'cancelled'; message: string; codeNeeded: boolean; child: ChildProcessWithoutNullStreams | null; abort: AbortController; timer: NodeJS.Timeout | undefined };
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
  if (op.phase === 'install' && process.platform !== 'win32' && op.child.pid) {
    try { process.kill(-op.child.pid, 'SIGTERM'); return; } catch { /* Process may already have exited. */ }
  }
  stopCli(op.child);
}

type AuthStatus = 'connected' | 'disconnected' | 'unknown';

async function checkAuth(engine: Engine): Promise<AuthStatus> {
  const bin = BIN[engine];
  if (!bin) return 'unknown';
  try {
    const child = spawnCli(bin, engine === 'claude' ? ['auth', 'status'] : ['login', 'status'], {});
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
      const parsed = JSON.parse(output);
      if (parsed.loggedIn === false) return 'disconnected';
      if (code === 0 && parsed.loggedIn === true) return 'connected';
    } else if (code === 0) return 'connected';
    else if (code === 1 && /not logged in/i.test(output)) return 'disconnected';
  } catch { /* A broken CLI is not proof of a disconnected account. */ }
  return 'unknown';
}

export async function providerStatus(engine: Engine) {
  const initialOp = operations.get(engine);
  const auth = BIN[engine] && initialOp?.state !== 'running' ? await checkAuth(engine) : 'unknown';
  const op = operations.get(engine);
  return { installed: !!BIN[engine], auth: op?.state === 'running' ? 'unknown' : auth, canInstall: supported(), operation: op ? { kind: op.kind, phase: op.phase, state: op.state, message: op.message, codeNeeded: op.codeNeeded } : null };
}

function isCurrent(engine: Engine, op: Operation) {
  return operations.get(engine) === op && op.state === 'running';
}

function finish(op: Operation, state: 'success' | 'error' | 'cancelled', message: string) {
  op.state = state;
  op.message = message;
  op.codeNeeded = false;
  clearTimeout(op.timer);
  op.timer = undefined;
}

function setDeadline(engine: Engine, op: Operation, milliseconds: number) {
  clearTimeout(op.timer);
  op.timer = setTimeout(() => {
    if (!isCurrent(engine, op)) return;
    finish(op, 'error', '시간이 초과되었습니다. 공식 안내를 확인하고 다시 시도하세요.');
    op.abort.abort();
    stopOperation(op);
  }, milliseconds);
}

function startLogin(engine: Engine, op: Operation) {
  if (!isCurrent(engine, op)) return;
  const bin = BIN[engine];
  if (!bin) {
    finish(op, 'error', '설치된 CLI를 찾지 못했습니다. 공식 설치 안내를 확인하고 다시 시도하세요.');
    return;
  }
  op.phase = 'login';
  op.message = '브라우저에서 로그인을 완료하세요.';
  op.child = null;
  setDeadline(engine, op, 300000);
  try {
    const child = spawnCli(bin, engine === 'claude' ? ['auth', 'login', '--claudeai'] : ['login'], {});
    op.child = child;
    // Only inspect the fixed prompt. Never retain or return CLI output or login URLs.
    let prompt = '';
    const inspect = (chunk: Buffer) => {
      if (!isCurrent(engine, op) || op.child !== child || engine !== 'claude') return;
      prompt = (prompt + chunk.toString()).slice(-256);
      if (/paste code here/i.test(prompt)) { op.codeNeeded = true; prompt = ''; }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.stdin.on('error', () => {});
    child.once('error', () => {
      if (isCurrent(engine, op) && op.child === child) finish(op, 'error', 'CLI를 실행하지 못했습니다. 공식 안내를 확인하세요.');
    });
    child.once('close', (code) => {
      if (!isCurrent(engine, op) || op.child !== child) return;
      op.child = null;
      if (code !== 0) {
        finish(op, 'error', '로그인을 완료하지 못했습니다. 브라우저와 공식 안내를 확인하세요.');
        return;
      }
      op.codeNeeded = false;
      op.message = '계정 연결 상태를 확인하는 중입니다.';
      void checkAuth(engine).then(auth => {
        if (!isCurrent(engine, op)) return;
        if (auth !== 'connected') {
          finish(op, 'error', '계정 연결을 확인하지 못했습니다. 브라우저에서 로그인을 완료한 뒤 다시 시도하세요.');
          return;
        }
        try {
          saveSettings({ engine });
          finish(op, 'success', '계정이 연결되었습니다. 이 서비스를 기본 AI로 사용합니다.');
        } catch {
          finish(op, 'error', '계정은 연결됐지만 기본 AI를 선택하지 못했습니다. 상단 모델 메뉴에서 직접 선택하세요.');
        }
      });
    });
    if (engine === 'codex') child.stdin.end();
  } catch {
    if (isCurrent(engine, op)) finish(op, 'error', 'CLI를 실행하지 못했습니다. 공식 안내를 확인하세요.');
  }
}

export function startProviderOperation(engine: Engine) {
  if (operations.get(engine)?.state === 'running') throw new Error('이미 작업이 진행 중입니다');
  const installed = !!BIN[engine];
  const op: Operation = {
    kind: 'connect', phase: installed ? 'login' : 'install', state: 'running',
    message: installed ? '브라우저에서 로그인을 완료하세요.' : '제공자의 공식 설치 프로그램으로 설치 중입니다.',
    codeNeeded: false, child: null, abort: new AbortController(), timer: undefined,
  };
  operations.set(engine, op);
  if (installed) { startLogin(engine, op); return; }
  if (!supported()) {
    finish(op, 'error', '이 운영체제 또는 CPU의 자동 설치는 지원하지 않습니다. 공식 설치 안내에 따라 CLI를 설치한 뒤 다시 연결하세요.');
    return;
  }
  setDeadline(engine, op, 600000);
  void (async () => {
    let dir: string | null = null;
    try {
      const script = await installerScript(engine, op.abort.signal);
      if (!isCurrent(engine, op)) return;
      dir = await mkdtemp(join(tmpdir(), 'paperlens-installer-'));
      if (!isCurrent(engine, op)) return;
      const windows = process.platform === 'win32';
      const path = join(dir, windows ? 'install.ps1' : 'install.sh');
      await writeFile(path, script, { mode: 0o600, flag: 'wx' });
      if (!isCurrent(engine, op)) return;
      const child = spawn(windows ? 'powershell.exe' : '/bin/bash', windows ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path] : [path], {
        stdio: 'pipe', windowsHide: true, detached: !windows,
        env: { ...process.env, CODEX_NON_INTERACTIVE: '1', ...(windows ? {} : { PATH: `${join(homedir(), '.local', 'bin')}${delimiter}${process.env.PATH ?? ''}` }) },
      });
      op.child = child;
      child.stdout.resume();
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.once('error', () => {
        if (isCurrent(engine, op) && op.child === child) finish(op, 'error', '공식 설치 프로그램을 실행하지 못했습니다. 공식 안내를 확인하세요.');
      });
      child.once('close', (code) => {
        if (!isCurrent(engine, op) || op.child !== child) return;
        op.child = null;
        if (code !== 0) finish(op, 'error', '설치하지 못했습니다. 네트워크와 공식 설치 안내를 확인하세요.');
        else startLogin(engine, op);
      });
      child.stdin.end();
      const cleanup = dir;
      dir = null;
      child.once('close', () => { void rm(cleanup, { recursive: true, force: true }).catch(() => {}); });
    } catch {
      if (isCurrent(engine, op)) finish(op, 'error', '공식 설치 프로그램을 내려받거나 실행하지 못했습니다. 네트워크와 공식 안내를 확인하세요.');
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  })();
}

export function submitProviderCode(engine: Engine, code: unknown) {
  const op = operations.get(engine);
  if (engine !== 'claude' || !op || op.state !== 'running' || op.phase !== 'login' || !op.codeNeeded || !op.child || typeof code !== 'string' || !code.trim() || code.length > 2048 || /[\r\n]/.test(code)) throw new Error('인증 코드를 전달할 수 없습니다');
  op.child.stdin.write(code.trim() + '\n');
  op.codeNeeded = false;
}

export function cancelProviderOperation(engine: Engine) {
  const op = operations.get(engine);
  if (op?.state === 'running') { finish(op, 'cancelled', '취소했습니다. 이미 진행된 설치나 브라우저 인증은 별도로 확인하세요.'); op.abort.abort(); stopOperation(op); }
}
export function cancelProviderOperations() { cancelProviderOperation('claude'); cancelProviderOperation('codex'); }
