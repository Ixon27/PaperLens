import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Run only on a disposable Windows CI runner, without account credentials.
if (process.platform !== 'win32' || !process.env.CI) throw new Error('Windows CI에서만 실행할 수 있습니다.');
const home = await mkdtemp(join(tmpdir(), 'paperlens-connect-smoke-'));
const windows = process.env.SystemRoot || 'C:\\Windows';
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(home, 'AppData', 'Local'),
  CODEX_HOME: join(home, '.codex'),
  CODEX_INSTALL_DIR: join(home, 'codex-bin'),
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  PATH: [join(windows, 'System32'), join(windows, 'System32', 'WindowsPowerShell', 'v1.0'), windows].join(delimiter),
});
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'PAPER_READER_DB_DIR', 'PAPER_READER_FILES', 'PAPER_READER_VAULT']) delete process.env[key];

// Config resolves CLI paths at import time; set the isolated home and PATH first.
const { providerStatus, startProviderOperation, cancelProviderOperations } = await import('../src/server/provider-connect');
async function check(engine: 'claude' | 'codex') {
  assert.equal((await providerStatus(engine)).installed, false, `${engine}: expected a fresh installation`);
  startProviderOperation(engine);
  const end = Date.now() + 600_000;
  while (Date.now() < end) {
    const status = await providerStatus(engine);
    if (status.operation?.state === 'error') throw new Error(`${engine}: ${status.operation.message}`);
    if (status.operation?.state === 'running' && status.operation.phase === 'login') {
      assert.equal(status.installed, true, `${engine}: installed CLI was not discovered`);
      await delay(2000);
      const login = await providerStatus(engine);
      assert.equal(login.operation?.state, 'running', `${engine}: browser login exited before authentication`);
      console.log(`${engine}: official installation completed and browser login started`);
      return;
    }
    await delay(1000);
  }
  throw new Error(`${engine}: timed out waiting for browser login`);
}

try {
  await Promise.all([check('claude'), check('codex')]);
} finally {
  cancelProviderOperations();
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
