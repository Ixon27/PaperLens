import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { BIN, PATHS } from '../config';
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

function appendModels(target: ModelChoice[], seen: Set<string>, data: unknown, engine: Engine): void {
  if (!Array.isArray(data)) throw new Error('CLI 모델 목록 형식이 올바르지 않습니다. CLI를 업데이트하세요.');
  for (const item of data) {
    if (!item || typeof item !== 'object' || item.hidden === true) continue;
    const value = engine === 'claude' ? item.value : item.model;
    if (typeof value !== 'string' || !value.trim() || seen.has(value)) continue;
    seen.add(value);
    target.push({
      value,
      label: typeof item.displayName === 'string' && item.displayName.trim() ? item.displayName : value,
      description: typeof item.description === 'string' ? item.description : '',
      ...(typeof item.resolvedModel === 'string' ? { resolvedModel: item.resolvedModel } : {}),
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
  const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
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
  else send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'paper_reader', title: 'Paper Reader', version: '1' } } });
  try {
    return await result.promise;
  } finally {
    clearTimeout(timer);
    shutdown.signal.removeEventListener('abort', onAbort);
    lines.close();
    child.stdin.end();
    if (child.exitCode === null) child.kill('SIGTERM');
    const forceKill = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2_000);
    await closed.promise;
    clearTimeout(forceKill);
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function discover(engine: Engine): Promise<EngineModels> {
  const bin = BIN[engine];
  if (!bin) return { models: [], error: `${engine === 'claude' ? 'Claude' : 'Codex'} CLI가 없습니다. 설치하고 로그인한 뒤 새로고침하세요.` };
  try { return { models: await queryCli(engine, bin), error: null }; }
  catch (error) { return { models: [], error: error instanceof Error ? error.message : '모델 목록을 불러오지 못했습니다' }; }
}

/** Share overlapping reads only; reopening settings or refreshing asks the CLIs again. */
export function getModelCatalog(): Promise<ModelCatalog> {
  pending ??= Promise.all([discover('claude'), discover('codex')])
    .then(([claude, codex]) => ({ claude, codex }))
    .finally(() => { pending = null; });
  return pending;
}

export async function shutdownModelCatalog(): Promise<void> {
  shutdown.abort();
  await pending;
}
