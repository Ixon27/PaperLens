import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const apiUrl = 'http://127.0.0.1:4317';
const devUrl = 'http://localhost:5173';
const logDir = join(homedir(), 'Library', 'Logs', 'paper-reader');
const logFile = join(logDir, 'server.log');

async function findRunningApp() {
  let response;
  try {
    response = await fetch(`${apiUrl}/api/engines`, { signal: AbortSignal.timeout(1000) });
  } catch {
    return { running: false, url: null };
  }
  const engines = await response.json().catch(() => null);
  if (!response.ok || typeof engines?.claude !== 'boolean' || typeof engines?.codex !== 'boolean') {
    throw new Error('4317 포트를 다른 프로그램이 사용하고 있습니다. 해당 프로그램을 종료한 뒤 다시 여세요.');
  }
  // Production serves the web app on 4317. A running development server uses Vite on 5173.
  for (const url of [apiUrl, devUrl]) {
    try {
      const page = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (page.ok && page.headers.get('content-type')?.includes('text/html') && /<title>paper-reader<\/title>/.test(await page.text())) {
        return { running: true, url };
      }
    } catch {
      // The API may be ready a moment before Vite; the startup wait below will check again.
    }
  }
  return { running: true, url: null };
}

async function launch() {
  let app = await findRunningApp();
  let child;
  let spawnError;
  if (!app.running) {
    if (!existsSync(join(root, 'dist', 'index.html'))) {
      throw new Error('앱 화면 빌드가 없습니다. paper-reader 폴더에서 npm run install:app 을 실행하세요.');
    }
    const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (!existsSync(tsx)) throw new Error('설치 파일이 없습니다. paper-reader 폴더에서 npm install 후 npm run install:app 을 실행하세요.');
    mkdirSync(logDir, { recursive: true });
    const log = openSync(logFile, 'a', 0o600);
    try {
      child = spawn(process.execPath, [tsx, 'src/server/index.ts'], {
        cwd: root,
        detached: true,
        stdio: ['ignore', log, log],
        env: {
          ...process.env,
          NODE_ENV: 'production',
          PATH: [dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin'), process.env.PATH ?? '/usr/bin:/bin'].join(delimiter),
        },
      });
      child.on('error', error => { spawnError = error; });
      child.unref();
    } finally {
      closeSync(log);
    }
  }
  const deadline = Date.now() + 20_000;
  while (!app.url && Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child && child.exitCode !== null) {
      const details = readFileSync(logFile, 'utf8').slice(-1800);
      throw new Error(`서버가 시작되지 않았습니다.\n${details}\n로그: ${logFile}`);
    }
    await delay(250);
    app = await findRunningApp();
  }
  if (!app.url) throw new Error(`서버 화면을 준비하지 못했습니다. 개발 서버가 켜져 있다면 Vite가 실행 중인지 확인하세요.\n로그: ${logFile}`);

  const { promise, resolve, reject } = Promise.withResolvers();
  const browser = spawn('/usr/bin/open', [app.url], { stdio: 'ignore' });
  browser.on('error', reject);
  browser.on('exit', code => code === 0 ? resolve() : reject(new Error('기본 브라우저를 열지 못했습니다.')));
  await promise;
  console.log(`Paper Reader: ${app.url}`);
}

try {
  await launch();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
