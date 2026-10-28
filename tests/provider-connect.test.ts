import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnCli: vi.fn(), stopCli: vi.fn(), spawn: vi.fn(), mkdtemp: vi.fn(), writeFile: vi.fn(), rm: vi.fn(), saveSettings: vi.fn(),
  bins: { claude: '/cli/claude' as string | null, codex: '/cli/codex' as string | null },
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs/promises', () => ({ mkdtemp: mocks.mkdtemp, writeFile: mocks.writeFile, rm: mocks.rm }));
vi.mock('../src/server/config', () => ({ BIN: mocks.bins }));
vi.mock('../src/server/llm/command', () => ({ spawnCli: mocks.spawnCli, stopCli: mocks.stopCli }));
vi.mock('../src/server/settings', () => ({ saveSettings: mocks.saveSettings }));
import { cancelProviderOperation, cancelProviderOperations, providerStatus, startProviderOperation, submitProviderCode } from '../src/server/provider-connect';

function child() {
  return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill: vi.fn() });
}

function statusChild(engine: 'claude' | 'codex', connected = true) {
  const proc = child();
  queueMicrotask(() => {
    proc.stdout.write(engine === 'claude' ? JSON.stringify({ loggedIn: connected }) : connected ? 'Logged in' : 'Not logged in');
    proc.emit('close', connected ? 0 : 1);
  });
  return proc;
}

beforeEach(() => {
  cancelProviderOperations();
  vi.clearAllMocks();
  mocks.bins.claude = '/cli/claude'; mocks.bins.codex = '/cli/codex';
  mocks.mkdtemp.mockResolvedValue('/tmp/provider-installer');
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.rm.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response('official installer'))));
});
afterEach(() => { cancelProviderOperations(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('uses the CLI status without exposing account details', async () => {
  const proc = child(); mocks.spawnCli.mockReturnValue(proc);
  const result = providerStatus('claude');
  proc.stdout.write(JSON.stringify({ loggedIn: true, email: 'private@example.com' }));
  proc.emit('close', 0);
  const status = await result;
  expect(status).toMatchObject({ installed: true, auth: 'connected' });
  expect(JSON.stringify(status)).not.toContain('private@example.com');
});

it('does not treat a failed status command as authenticated', async () => {
  const proc = child(); mocks.spawnCli.mockReturnValue(proc);
  const result = providerStatus('claude');
  proc.stdout.write(JSON.stringify({ loggedIn: true }));
  proc.emit('close', 1);
  expect(await result).toMatchObject({ auth: 'unknown' });
});

it.each(['claude', 'codex'] as const)('starts the installed %s official browser login without a download', async (engine) => {
  const proc = child(); mocks.spawnCli.mockReturnValue(proc);
  startProviderOperation(engine);
  expect(mocks.spawnCli).toHaveBeenCalledWith(`/cli/${engine}`, engine === 'claude' ? ['auth', 'login', '--claudeai'] : ['login'], {});
  expect(fetch).not.toHaveBeenCalled();
  proc.stdout.write('https://example.test/login?secret=private');
  const status = await providerStatus(engine);
  expect(status).toMatchObject({ installed: true, auth: 'unknown', operation: { kind: 'connect', phase: 'login', state: 'running' } });
  expect(JSON.stringify(status)).not.toContain('private');
  cancelProviderOperation(engine);
  expect(mocks.stopCli).toHaveBeenCalledWith(proc);
});

it.each(['claude', 'codex'] as const)('installs %s then discovers and starts its login', async (engine) => {
  mocks.bins[engine] = null;
  const installer = child(), login = child();
  mocks.spawn.mockReturnValue(installer);
  mocks.spawnCli.mockImplementation((_bin, args: string[]) => args.includes('status') ? statusChild(engine) : login);
  startProviderOperation(engine);
  expect(await providerStatus(engine)).toMatchObject({ installed: false, operation: { kind: 'connect', phase: 'install', state: 'running' } });
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
  installer.stdout.write('installer secret');
  mocks.bins[engine] = `/cli/${engine}`;
  installer.emit('close', 0);
  expect(mocks.spawnCli).toHaveBeenCalledWith(`/cli/${engine}`, engine === 'claude' ? ['auth', 'login', '--claudeai'] : ['login'], {});
  expect(await providerStatus(engine)).toMatchObject({ operation: { phase: 'login', state: 'running' } });
  expect(mocks.rm).toHaveBeenCalledWith('/tmp/provider-installer', { recursive: true, force: true });
  login.emit('close', 0);
  await vi.waitFor(async () => expect((await providerStatus(engine)).operation?.state).toBe('success'));
  expect(mocks.saveSettings).toHaveBeenCalledWith({ engine });
});

it.each(['claude', 'codex'] as const)('does not select %s when login exits but authentication is unconfirmed', async (engine) => {
  const login = child();
  mocks.spawnCli.mockImplementation((_bin, args: string[]) => args.includes('status') ? statusChild(engine, false) : login);
  startProviderOperation(engine);
  login.emit('close', 0);
  await vi.waitFor(async () => expect((await providerStatus(engine)).operation?.state).toBe('error'));
  expect(mocks.saveSettings).not.toHaveBeenCalled();
});

it('does not change the selected AI if verification is cancelled', async () => {
  const login = child(), status = child();
  mocks.spawnCli.mockImplementation((_bin, args: string[]) => args.includes('status') ? status : login);
  startProviderOperation('codex');
  login.emit('close', 0);
  cancelProviderOperation('codex');
  status.stdout.write('Logged in');
  status.emit('close', 0);
  await Promise.resolve();
  expect(mocks.saveSettings).not.toHaveBeenCalled();
  mocks.bins.codex = null;
  expect(await providerStatus('codex')).toMatchObject({ operation: { state: 'cancelled' } });
});

it('reports installer failure and missing installed binary without launching login', async () => {
  mocks.bins.claude = null;
  const installer = child(); mocks.spawn.mockReturnValue(installer);
  startProviderOperation('claude');
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
  installer.stderr.write('private installer output'); installer.emit('close', 1);
  let status = await providerStatus('claude');
  expect(status).toMatchObject({ operation: { phase: 'install', state: 'error' } });
  expect(JSON.stringify(status)).not.toContain('private installer output');
  expect(mocks.spawnCli).not.toHaveBeenCalled();
  const second = child(); mocks.spawn.mockReturnValue(second);
  startProviderOperation('claude');
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));
  second.emit('close', 0);
  status = await providerStatus('claude');
  expect(status).toMatchObject({ operation: { phase: 'install', state: 'error' } });
  expect(status.operation?.message).toContain('찾지 못했습니다');
  expect(mocks.spawnCli).not.toHaveBeenCalled();
});

it('does not open a browser after cancellation during download', async () => {
  mocks.bins.codex = null;
  const download = Promise.withResolvers<Response>();
  vi.stubGlobal('fetch', vi.fn().mockReturnValue(download.promise));
  startProviderOperation('codex');
  cancelProviderOperation('codex');
  download.resolve(new Response('official installer'));
  const settled = Promise.withResolvers<void>();
  setImmediate(settled.resolve);
  await settled.promise;
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.spawnCli).not.toHaveBeenCalled();
  expect(await providerStatus('codex')).toMatchObject({ operation: { phase: 'install', state: 'cancelled' } });
});

it('cleans up an installer cancelled while its script is being written', async () => {
  mocks.bins.claude = null;
  const writing = Promise.withResolvers<void>();
  mocks.writeFile.mockReturnValue(writing.promise);
  startProviderOperation('claude');
  await vi.waitFor(() => expect(mocks.writeFile).toHaveBeenCalledOnce());
  cancelProviderOperation('claude');
  writing.resolve();
  await vi.waitFor(() => expect(mocks.rm).toHaveBeenCalledWith('/tmp/provider-installer', { recursive: true, force: true }));
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.spawnCli).not.toHaveBeenCalled();
});

it('reports a download error without leaking its details', async () => {
  mocks.bins.claude = null;
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private network detail')));
  startProviderOperation('claude');
  await vi.waitFor(async () => expect((await providerStatus('claude')).operation?.state).toBe('error'));
  const status = await providerStatus('claude');
  expect(status.operation?.phase).toBe('install');
  expect(JSON.stringify(status)).not.toContain('private network detail');
  expect(mocks.spawnCli).not.toHaveBeenCalled();
});

it('times out a login and ignores a later successful child exit', async () => {
  vi.useFakeTimers();
  const proc = child(); mocks.spawnCli.mockReturnValue(proc);
  startProviderOperation('codex');
  vi.advanceTimersByTime(300000);
  expect(mocks.stopCli).toHaveBeenCalledWith(proc);
  proc.emit('close', 0);
  mocks.bins.codex = null;
  expect(await providerStatus('codex')).toMatchObject({ auth: 'unknown', operation: { phase: 'login', state: 'error' } });
});

it('ignores stale installer callbacks and keeps providers independent', async () => {
  mocks.bins.claude = null;
  const installer = child(), login = child(), other = child();
  mocks.spawn.mockReturnValue(installer);
  mocks.spawnCli.mockReturnValueOnce(other).mockReturnValueOnce(login);
  startProviderOperation('claude');
  startProviderOperation('codex');
  expect(() => startProviderOperation('claude')).toThrow('이미 작업');
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
  cancelProviderOperation('claude');
  mocks.bins.claude = '/cli/claude';
  startProviderOperation('claude');
  installer.emit('close', 0);
  installer.emit('error', new Error('stale'));
  expect(mocks.spawnCli).toHaveBeenCalledTimes(2);
  expect(await providerStatus('claude')).toMatchObject({ operation: { phase: 'login', state: 'running' } });
  expect(await providerStatus('codex')).toMatchObject({ operation: { phase: 'login', state: 'running' } });
});

it('passes a Claude verification code only to the live process and ignores stale prompts', async () => {
  const proc = child(); mocks.spawnCli.mockReturnValue(proc);
  startProviderOperation('claude');
  proc.stdout.write('Paste code here if prompted >');
  expect(await providerStatus('claude')).toMatchObject({ operation: { codeNeeded: true } });
  expect(() => submitProviderCode('claude', 'bad\ncode')).toThrow();
  submitProviderCode('claude', 'example-code');
  expect(proc.stdin.read().toString()).toBe('example-code\n');
  expect(JSON.stringify(await providerStatus('claude'))).not.toContain('example-code');
  cancelProviderOperation('claude');
  const next = child(); mocks.spawnCli.mockReturnValue(next);
  startProviderOperation('claude');
  proc.stdout.write('Paste code here if prompted >');
  proc.emit('close', 0);
  expect(await providerStatus('claude')).toMatchObject({ operation: { state: 'running', codeNeeded: false } });
  expect(() => submitProviderCode('claude', 'example-code')).toThrow();
});

it('reports login failure without exposing output', async () => {
  const proc = child(); mocks.spawnCli.mockReturnValue(proc);
  startProviderOperation('codex');
  proc.stderr.write('secret login URL'); proc.emit('close', 1);
  mocks.bins.codex = null;
  const status = await providerStatus('codex');
  expect(status).toMatchObject({ operation: { phase: 'login', state: 'error' } });
  expect(JSON.stringify(status)).not.toContain('secret');
});

it('distinguishes a missing CLI from an unknown authentication status', async () => {
  mocks.bins.codex = null;
  expect(await providerStatus('codex')).toMatchObject({ installed: false, auth: 'unknown' });
});
