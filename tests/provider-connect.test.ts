import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawnCli: vi.fn(), stopCli: vi.fn(), bins: { claude: '/cli/claude' as string | null, codex: '/cli/codex' as string | null } }));
vi.mock('../src/server/config', () => ({ BIN: mocks.bins }));
vi.mock('../src/server/llm/command', () => ({ spawnCli: mocks.spawnCli, stopCli: mocks.stopCli }));
import { cancelProviderOperation, providerStatus, startProviderOperation, submitProviderCode } from '../src/server/provider-connect';

function child() {
  return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill: vi.fn() });
}

beforeEach(() => { mocks.spawnCli.mockReset(); mocks.stopCli.mockReset(); mocks.bins.claude = '/cli/claude'; mocks.bins.codex = '/cli/codex'; });

it('uses the CLI status without exposing account details', async () => {
  const proc = child(); mocks.spawnCli.mockReturnValue(proc);
  const result = providerStatus('claude');
  proc.stdout.write(JSON.stringify({ loggedIn: true, email: 'private@example.com' }));
  proc.emit('close', 0);
  const status = await result;
  expect(status).toMatchObject({ installed: true, auth: 'connected' });
  expect(JSON.stringify(status)).not.toContain('private@example.com');
});

it('starts the official browser login and supports cancellation without returning CLI output', async () => {
  const proc = child(); mocks.spawnCli.mockReturnValue(proc);
  startProviderOperation('claude', 'login');
  proc.stdout.write('secret');
  cancelProviderOperation('claude');
  expect(mocks.stopCli).toHaveBeenCalledWith(proc);
  mocks.bins.claude = null;
  expect(await providerStatus('claude')).toMatchObject({ operation: { state: 'cancelled' } });
  expect(JSON.stringify(await providerStatus('claude'))).not.toContain('secret');
});

it('passes an optional Claude browser code only to the live CLI', async () => {
  const proc = child(); mocks.spawnCli.mockReturnValue(proc);
  startProviderOperation('claude', 'login');
  proc.stdout.write('Paste code here if prompted >');
  expect(await providerStatus('claude')).toMatchObject({ operation: { codeNeeded: true } });
  expect(() => submitProviderCode('claude', 'bad\ncode')).toThrow();
  submitProviderCode('claude', 'example-code');
  expect(await providerStatus('claude')).toMatchObject({ operation: { codeNeeded: false } });
  expect(JSON.stringify(await providerStatus('claude'))).not.toContain('example-code');
  cancelProviderOperation('claude');
});

it('distinguishes a missing CLI from an unknown authentication status', async () => {
  mocks.bins.codex = null;
  expect(await providerStatus('codex')).toMatchObject({ installed: false, auth: 'unknown' });
});
