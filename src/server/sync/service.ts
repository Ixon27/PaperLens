import { db } from '../db';
import { desktopBridge } from '../desktop-bridge';
import { HttpError } from '../http-error';
import { DriveTransport } from './drive';
import { syncOnce } from './engine';
import { AuthExpiredError, GoogleAuth, type SecretStore } from './google-auth';
import { googleConfig } from './google-config';
import { getMeta, setMeta, useAccount } from './state';

const FIRST_SYNC_DELAY_MS = 10_000;
const SYNC_INTERVAL_MS = 5 * 60_000;

export interface SyncStatus {
  /** Sync runs only inside the desktop app. */
  available: boolean;
  /** This build carries a Google OAuth client. */
  configured: boolean;
  connected: boolean;
  email: string | null;
  syncing: boolean;
  loginPending: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  /** Local versions replaced by a newer edit from another device, kept in the database. */
  conflicts: number;
  devices: number;
  /** When another device's changes were last applied here (the library reloads on change). */
  changedAt: string | null;
}

function secretStore(): SecretStore {
  const bridge = desktopBridge();
  if (bridge) return { load: () => bridge.loadSecret('google'), save: (v) => bridge.saveSecret('google', v), clear: () => bridge.clearSecret('google') };
  // Development server: the login lasts only as long as the process.
  let value: string | null = null;
  return { load: async () => value, save: async (v) => { value = v; }, clear: async () => { value = null; } };
}

let auth: GoogleAuth | null = null;
const getAuth = () => (auth ??= new GoogleAuth(googleConfig(), secretStore(), { openBrowser: async (url) => { await desktopBridge()?.openExternal(url); } }));

let running: Promise<void> | null = null;
let controller: AbortController | null = null;
let lastError: string | null = null;
let loginPending = false;
let devices = 0;
let firstTimer: NodeJS.Timeout | undefined;
let interval: NodeJS.Timeout | undefined;

export const syncAvailable = () => process.env.PAPER_READER_DESKTOP === '1';

function conflictCount(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM sync_conflicts').get();
  return typeof row?.n === 'number' ? row.n : 0;
}

export async function syncStatus(): Promise<SyncStatus> {
  const a = getAuth();
  const connected = a.configured && (await a.connected());
  return {
    available: syncAvailable(),
    configured: a.configured,
    connected,
    email: connected ? getMeta('email') || null : null,
    syncing: running !== null,
    loginPending,
    lastSyncAt: getMeta('lastSyncAt'),
    lastError,
    conflicts: conflictCount(),
    devices,
    changedAt: getMeta('changedAt'),
  };
}

/** Start the browser sign-in; sync starts by itself once Google redirects back. */
export async function connectGoogle(): Promise<{ url: string }> {
  const a = getAuth();
  if (!a.configured) throw new HttpError(400, '이 앱에는 Google 연동 정보가 아직 설정되지 않았습니다');
  const { url, done } = await a.beginLogin();
  loginPending = true;
  lastError = null;
  done.then(
    (account) => {
      loginPending = false;
      useAccount(account.sub);
      setMeta('email', account.email ?? '');
      void syncNow();
    },
    (e: unknown) => {
      loginPending = false;
      const message = e instanceof Error ? e.message : String(e);
      if (message !== '취소됨') lastError = message;
    },
  );
  return { url };
}

/** Sign out here; files already in Google Drive and on this device stay. */
export async function disconnectGoogle(): Promise<void> {
  controller?.abort();
  await running;
  await getAuth().disconnect();
  setMeta('email', null);
  lastError = null;
  devices = 0;
}

/** Never rejects: failures are reported through `syncStatus().lastError`. */
export function syncNow(): Promise<void> {
  running ??= (async () => {
    const a = getAuth();
    if (!a.configured || !(await a.connected())) return;
    const abort = (controller = new AbortController());
    try {
      const result = await syncOnce(new DriveTransport(googleConfig(), a), { signal: abort.signal });
      devices = result.devices;
      lastError = null;
    } catch (e) {
      if (abort.signal.aborted) return;
      const message = e instanceof Error ? e.message : String(e);
      lastError = e instanceof AuthExpiredError ? message : `동기화하지 못했습니다: ${message}`;
      console.error('동기화 실패:', message);
    }
  })()
    .catch(() => {})
    .finally(() => {
      running = null;
      controller = null;
    });
  return running;
}

export function startSyncScheduler(): void {
  if (interval) return;
  firstTimer = setTimeout(() => void syncNow(), FIRST_SYNC_DELAY_MS);
  interval = setInterval(() => void syncNow(), SYNC_INTERVAL_MS);
  firstTimer.unref();
  interval.unref();
}

export async function stopSyncScheduler(): Promise<void> {
  clearTimeout(firstTimer);
  clearInterval(interval);
  firstTimer = interval = undefined;
  controller?.abort();
  await running;
}
