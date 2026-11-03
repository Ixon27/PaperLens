import { spawnCli, stopCli } from './command';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { BIN, PATHS, discoverCli } from '../config';
import type { Engine } from '../settings';
import type { EngineModels, ModelCatalog, ModelChoice } from '../../shared/models';

interface WireMessage {
  type?: string;
  id?: number;
  error?: { message?: string };
  result?: { data?: unknown; nextCursor?: unknown };
  response?: {
    subtype?: string;
    request_id?: string;
    error?: string;
    response?: { models?: unknown };
  };
}

type Send = (message: unknown) => void;
const shutdown = new AbortController();
let pending: Promise<ModelCatalog> | null = null;

const isEffort = (v: unknown): v is string => typeof v === 'string' && v !== 'auto' && /^[a-z]+$/.test(v);

export function appendModels(target: ModelChoice[], seen: Set<string>, data: unknown, engine: Engine): void {
  if (!Array.isArray(data)) throw new Error('CLI 모델 목록 형식이 올바르지 않습니다. CLI를 업데이트하세요.');
  for (const item of data) {
    if (!item || typeof item !== 'object' || item.hidden === true) continue;
    const value = engine === 'claude' ? item.value : item.model;
    if (typeof value !== 'string' || !value.trim() || seen.has(value)) continue;
    seen.add(value);
    const efforts: string[] = engine === 'claude'
      ? item.supportsEffort === true && Array.isArray(item.supportedEffortLevels) ? item.supportedEffortLevels.filter(isEffort) : []
      : Array.isArray(item.supportedReasoningEfforts)
        ? item.supportedReasoningEfforts.map((e: { reasoningEffort?: unknown } | null) => e?.reasoningEffort).filter(isEffort)
        : [];
    target.push({
      value,
      label: typeof item.displayName === 'string' && item.displayName.trim() ? item.displayName : value,
      description: typeof item.description === 'string' ? item.description : '',
      ...(typeof item.resolvedModel === 'string' ? { resolvedModel: item.resolvedModel } : {}),
      efforts: [...new Set(efforts)],
      ...(isEffort(item.defaultReasoningEffort ?? item.defaultEffort) && efforts.includes(item.defaultReasoningEffort ?? item.defaultEffort)
        ? { defaultEffort: item.defaultReasoningEffort ?? item.defaultEffort } : {}),
      ...(item.isDefault === true ? { isDefault: true } : {}),
    });
  }
}

/** Metadata-only handshakes: never sends a prompt, starts a turn, or runs a model. */
async function queryCli(engine: Engine, bin: string): Promise<ModelChoice[]> {
  shutdown.signal.throwIfAborted();
  const name = engine === 'claude' ? 'Claude' : 'Codex';
  const cwd = mkdtempSync(join(PATHS.tmp, 'models-'));
  const args = engine === 'claude' ? [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--tools', '', '--no-session-persistence', '--setting-sources', 'project',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  ] : ['app-server', '--listen', 'stdio://'];
  const child = spawnCli(bin, args, { cwd });
  const closed = Promise.withResolvers<void>();
  const result = Promise.withResolvers<ModelChoice[]>();
  const lines = createInterface({ input: child.stdout });
  const send: Send = message => { child.stdin.write(JSON.stringify(message) + '\n'); };
  const models: ModelChoice[] = [];
  const seenModels = new Set<string>();
  const seenCursors = new Set<string>();
  let pageRequest = 2;
  const requestPage = (cursor?: string) => send({ method: 'model/list', id: pageRequest, params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) } });
  const onAbort = () => result.reject(new Error('앱 종료로 모델 목록 조회를 중단했습니다'));
  const timer = setTimeout(() => result.reject(new Error(`${name} 모델 목록 조회 시간이 초과되었습니다. CLI 로그인과 네트워크를 확인하세요.`)), 20_000);
  shutdown.signal.addEventListener('abort', onAbort, { once: true });
  child.once('error', () => result.reject(new Error(`${name} CLI를 실행하지 못했습니다. CLI 설치 상태를 확인하세요.`)));
  child.once('close', code => {
    closed.resolve();
    result.reject(new Error(`${name} CLI가 모델 목록을 반환하지 않고 종료되었습니다 (${code ?? 'signal'}). CLI를 업데이트하고 로그인 상태를 확인하세요.`));
  });
  child.stdin.on('error', () => result.reject(new Error(`${name} CLI 연결이 종료되었습니다`)));
  // Drain diagnostics without returning CLI account details or credentials to the renderer.
  child.stderr.resume();
  lines.on('line', line => {
    let message: WireMessage;
    try { message = JSON.parse(line) as WireMessage; }
    catch { return; }
    if (!message || typeof message !== 'object') return;
    try {
      if (engine === 'claude') {
        if (message.type !== 'control_response' || message.response?.request_id !== 'models') return;
        if (message.response.subtype !== 'success') throw new Error('Claude 모델 목록을 불러오지 못했습니다. CLI 로그인 상태를 확인하세요.');
        appendModels(models, seenModels, message.response.response?.models, engine);
      } else {
        if (message.id === 1) {
          if (message.error) throw new Error('Codex 초기화에 실패했습니다. CLI 설정과 로그인 상태를 확인하세요.');
          send({ method: 'initialized', params: {} });
          requestPage();
          return;
        }
        if (message.id !== pageRequest) return;
        if (message.error) throw new Error('Codex 모델 목록을 불러오지 못했습니다. CLI 설정과 로그인 상태를 확인하세요.');
        appendModels(models, seenModels, message.result?.data, engine);
        const cursor = message.result?.nextCursor;
        if (cursor !== null && cursor !== undefined) {
          if (typeof cursor !== 'string' || !cursor || seenCursors.has(cursor)) throw new Error('Codex 모델 목록의 페이지 정보가 올바르지 않습니다');
          seenCursors.add(cursor);
          pageRequest++;
          requestPage(cursor);
          return;
        }
      }
      if (!models.length) throw new Error(`${name} CLI가 선택 가능한 모델을 반환하지 않았습니다. CLI를 업데이트하고 로그인 상태를 확인하세요.`);
      result.resolve(models);
    } catch (error) { result.reject(error); }
  });
  if (engine === 'claude') send({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } });
  else send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'paper_reader', title: 'PaperLens', version: '1' } } });
  try {
    return await result.promise;
  } finally {
    clearTimeout(timer);
    shutdown.signal.removeEventListener('abort', onAbort);
    lines.close();
    child.stdin.end();
    stopCli(child);
    const forceKill = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2_000);
    await closed.promise;
    clearTimeout(forceKill);
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** Return only a version token, never arbitrary CLI output (which can include account details). */
export function parseCliVersion(output: string): string | null {
  return output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
}

async function cliVersion(bin: string): Promise<string | null> {
  try {
    const child = spawnCli(bin, ['--version'], {});
    child.stdin.end();
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(0, 1024); });
    child.stderr.resume();
    const { promise, resolve } = Promise.withResolvers<string | null>();
    const timer = setTimeout(() => { stopCli(child); resolve(null); }, 5_000);
    child.once('error', () => { clearTimeout(timer); resolve(null); });
    child.once('close', code => { clearTimeout(timer); resolve(code === 0 ? parseCliVersion(output) : null); });
    return await promise;
  } catch { return null; }
}

const metadata = new Map<Engine, { bin: string | null; at: number; value: EngineModels }>();
const discovering = new Map<Engine, { bin: string | null; promise: Promise<EngineModels> }>();
let generation = 0;

/** Short-lived metadata sharing for preview/execution, keyed to the actual executable. No model requests. */
export function getEngineModels(engine: Engine, bin = BIN[engine], refresh = false): Promise<EngineModels> {
  const cached = metadata.get(engine);
  if (!refresh && cached?.bin === bin && Date.now() - cached.at < 15_000) return Promise.resolve(cached.value);
  const active = discovering.get(engine);
  if (active?.bin === bin) return active.promise;
  const epoch = generation;
  const location = discoverCli(engine);
  const source = location?.path === bin ? location.source : null;
  const promise = (async (): Promise<EngineModels> => {
    if (!bin) return { models: [], error: `${engine === 'claude' ? 'Claude' : 'Codex'} CLI가 없습니다. 설치하고 로그인한 뒤 새로고침하세요.`, cli: { path: null, version: null, source: null } };
    const [version, result] = await Promise.all([
      cliVersion(bin),
      queryCli(engine, bin).then(models => ({ models, error: null })).catch(error => ({ models: [], error: error instanceof Error ? error.message : '모델 목록을 불러오지 못했습니다' })),
    ]);
    return { ...result, cli: { path: bin, version, source } };
  })().then(value => {
    if (generation === epoch) metadata.set(engine, { bin, at: Date.now(), value });
    return value;
  }).finally(() => { if (discovering.get(engine)?.promise === promise) discovering.delete(engine); });
  discovering.set(engine, { bin, promise });
  return promise;
}

export function invalidateModelCatalog(): void {
  generation++;
  metadata.clear();
  discovering.clear();
  pending = null;
}

/** Share overlapping reads only; reopening settings or refreshing asks the CLIs again. */
export function getModelCatalog(): Promise<ModelCatalog> {
  const request: Promise<ModelCatalog> = pending ??= Promise.all([getEngineModels('claude', BIN.claude, true), getEngineModels('codex', BIN.codex, true)])
    .then(([claude, codex]) => ({ claude, codex }))
    .finally(() => { if (pending === request) pending = null; });
  return request;
}

export async function shutdownModelCatalog(): Promise<void> {
  shutdown.abort();
  await Promise.all([pending, ...[...discovering.values()].map(entry => entry.promise)]);
}
