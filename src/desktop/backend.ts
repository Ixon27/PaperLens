import type { ServerType } from '@hono/node-server';
import { createBridgeClient, setDesktopBridge } from '../server/desktop-bridge';
import type { BackendMessage, ParentMessage } from './protocol';

const parent = process.parentPort;
if (!parent) throw new Error('데스크톱 부모 프로세스가 없습니다.');
const parentPid = Number(process.env.PAPER_READER_PARENT_PID);
let server: ServerType | undefined;
let cancelJobs: (() => Promise<void>) | undefined;
let shutdownLlm: (() => Promise<void>) | undefined;
let stopSync: (() => Promise<void>) | undefined;
let stopping = false;
let started = false;

function send(message: BackendMessage) {
  parent?.postMessage(message);
}

const bridgeClient = createBridgeClient(send);

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(watchdog);
  // A stuck CLI or an open SSE connection must not keep an invisible app alive.
  const deadline = setTimeout(() => process.exit(code || 1), 5_000);
  try {
    const stoppedLlm = shutdownLlm?.();
    const cancelled = cancelJobs?.();
    const stoppedSync = stopSync?.();
    server?.close();
    if (server && 'closeAllConnections' in server) server.closeAllConnections();
    await Promise.all([stoppedLlm, cancelled, stoppedSync]);
  } catch (error) {
    console.error('백엔드 종료 실패:', error);
    code = 1;
  } finally {
    clearTimeout(deadline);
    process.exit(code);
  }
}

const watchdog = setInterval(() => {
  try {
    if (!Number.isSafeInteger(parentPid) || parentPid <= 1) throw new Error('잘못된 부모 PID');
    process.kill(parentPid, 0);
  } catch {
    void shutdown(1);
  }
}, 2_000);

async function start(token: string) {
  if (started || stopping) return;
  started = true;
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('잘못된 세션 인증 정보');
  // Import only after the parent has provided the environment and session token.
  const [{ startServer }, { cancelAllJobs }, llm, sync] = await Promise.all([
    import('../server/app'),
    import('../server/jobs'),
    import('../server/llm/index'),
    import('../server/sync/service'),
  ]);
  cancelJobs = cancelAllJobs;
  shutdownLlm = llm.shutdownLlm;
  if (stopping) return;
  setDesktopBridge(bridgeClient.bridge);
  server = await startServer({ port: 0, token, production: true });
  if (stopping) {
    server.close();
    if ('closeAllConnections' in server) server.closeAllConnections();
    return;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('백엔드 포트를 확인하지 못했습니다.');
  send({ type: 'ready', port: address.port });
  stopSync = sync.stopSyncScheduler;
  sync.startSyncScheduler();
}

function fatal(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error);
  send({ type: 'fatal', message });
  void shutdown(1);
}

parent.on('message', ({ data }: { data: ParentMessage }) => {
  switch (data.type) {
    case 'shutdown': void shutdown(); break;
    case 'start': void start(data.token).catch(fatal); break;
    case 'bridgeResult': bridgeClient.handleResult(data); break;
    default: data satisfies never;
  }
});
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
