import type { BridgeOp, BridgeRequest, BridgeResult, SecretName } from '../desktop/protocol';

/** Services only the Electron main process can provide (OS keychain, system browser). */
export interface DesktopBridge {
  loadSecret(name: SecretName): Promise<string | null>;
  saveSecret(name: SecretName, value: string): Promise<void>;
  clearSecret(name: SecretName): Promise<void>;
  openExternal(url: string): Promise<void>;
}

let current: DesktopBridge | null = null;

export function setDesktopBridge(bridge: DesktopBridge | null): void {
  current = bridge;
}

/** null outside the Electron backend (dev server, tests). */
export function desktopBridge(): DesktopBridge | null {
  return current;
}

export const BRIDGE_TIMEOUT_MS = 15_000;

export interface BridgeClient {
  bridge: DesktopBridge;
  handleResult(result: BridgeResult): void;
  /** Rejects every pending request, e.g. when the parent goes away. */
  close(reason?: string): void;
}

/** Correlates bridge requests with the parent's results by id; `post` sends one message to the parent. */
export function createBridgeClient(post: (message: BridgeRequest) => void, timeoutMs = BRIDGE_TIMEOUT_MS): BridgeClient {
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: string | null) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  function request(op: BridgeOp): Promise<string | null> {
    const id = nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<string | null>();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('데스크톱 앱이 응답하지 않습니다'));
    }, timeoutMs);
    // A pending request must not keep a shutting-down backend alive.
    timer.unref();
    pending.set(id, { resolve, reject, timer });
    try {
      post({ type: 'bridge', id, ...op });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  return {
    bridge: {
      loadSecret: (name) => request({ op: 'loadSecret', name }),
      saveSecret: async (name, value) => { await request({ op: 'saveSecret', name, value }); },
      clearSecret: async (name) => { await request({ op: 'clearSecret', name }); },
      openExternal: async (url) => { await request({ op: 'openExternal', url }); },
    },
    handleResult(result) {
      const entry = pending.get(result.id);
      // Late answers to timed-out requests are dropped.
      if (!entry) return;
      pending.delete(result.id);
      clearTimeout(entry.timer);
      if (result.ok) entry.resolve(result.value ?? null);
      else entry.reject(new Error(result.error || '데스크톱 요청이 실패했습니다'));
    },
    close(reason = '데스크톱 앱 연결이 끊어졌습니다') {
      for (const [id, entry] of pending) {
        pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(new Error(reason));
      }
    },
  };
}
