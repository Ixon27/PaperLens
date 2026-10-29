import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage, session, shell, utilityProcess } from 'electron';
import type { IpcMainInvokeEvent, MenuItemConstructorOptions, UtilityProcess } from 'electron';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDataDir, resolveStoragePaths } from '../shared/storage';
import { IPC, parseBridgeRequest } from './protocol';
import type { BackendMessage, BridgeRequest, BridgeResult, DesktopInfo, SecretName } from './protocol';

const isMac = process.platform === 'darwin';
// The data folder keeps its original `paper-reader` name, so a renamed app opens the same library.
app.setName('PaperLens');
const requestedUserData = process.env.PAPER_READER_USER_DATA ?? defaultDataDir();
const userData = requestedUserData === '~' || requestedUserData.startsWith('~/') ? join(homedir(), requestedUserData.slice(1)) : requestedUserData;
const logDir = isMac ? join(homedir(), 'Library', 'Logs', 'paper-reader') : join(defaultDataDir(), 'logs');
const logFile = join(logDir, 'desktop.log');
let startupError: unknown;
try {
  mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  app.setAppLogsPath(logDir);
  mkdirSync(logDir, { recursive: true });
  if (existsSync(logFile) && statSync(logFile).size > 2 * 1024 * 1024) renameSync(logFile, `${logFile}.previous`);
  const debugPort = process.env.PAPER_READER_DEBUG_PORT;
  if (debugPort) {
    if (!/^\d+$/.test(debugPort) || Number(debugPort) < 1024 || Number(debugPort) > 65535) throw new Error('PAPER_READER_DEBUG_PORT는 1024–65535 범위의 포트여야 합니다.');
    app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
    app.commandLine.appendSwitch('remote-debugging-port', debugPort);
  }
} catch (error) {
  startupError = error;
}
const token = randomBytes(32).toString('hex');
const storage = resolveStoragePaths({ userData });
const info: DesktopInfo = { version: app.getVersion(), dataDir: storage.dbDir, filesDir: storage.files, logDir };
let window: BrowserWindow | null = null;
let backend: UtilityProcess | null = null;
let backendOrigin = '';
let quitting = false;
let mayQuit = false;
let failureShown = false;

const themeBackground = () => nativeTheme.shouldUseDarkColors ? '#11151c' : '#f3f6f9';
const themeFile = join(userData, 'theme.json');
type ThemeSource = 'system' | 'light' | 'dark';
const isThemeSource = (value: unknown): value is ThemeSource => value === 'system' || value === 'light' || value === 'dark';

/** The renderer's last theme choice, so the window opens in it without a light first frame. */
function readThemeSource(): ThemeSource {
  try {
    const theme: unknown = JSON.parse(readFileSync(themeFile, 'utf8')).theme;
    return isThemeSource(theme) ? theme : 'system';
  } catch {
    return 'system';
  }
}

function log(message: string) {
  const safe = message.replaceAll(token, '[redacted]');
  try { appendFileSync(logFile, `${new Date().toISOString()} ${safe}\n`, { mode: 0o600 }); }
  catch { console.error(safe); }
}

async function fail(error: unknown) {
  log(error instanceof Error ? error.stack ?? error.message : String(error));
  if (failureShown || quitting) return;
  failureShown = true;
  dialog.showErrorBox('PaperLens를 열지 못했습니다', `앱을 종료한 뒤 다시 실행해 주세요. 문제가 계속되면 로그를 확인해 주세요.\n\n${error instanceof Error ? error.message.replaceAll(token, '[redacted]') : '알 수 없는 오류'}\n\n로그: ${logFile}`);
  app.quit();
}

function isAppUrl(value: string) {
  try { return Boolean(backendOrigin) && new URL(value).origin === backendOrigin; }
  catch { return false; }
}

/** The validated href, or null for anything the OS must not open (other schemes, credentials, the app itself). */
function externalUrl(value: string, protocols: readonly string[] = ['https:', 'http:', 'obsidian:']) {
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol) || url.username || url.password || isAppUrl(value)) return null;
    return url.href;
  } catch { return null; /* Malformed links must never reach the OS. */ }
}

function openExternal(value: string) {
  const href = externalUrl(value);
  if (href) void shell.openExternal(href).catch(error => log(`외부 링크 열기 실패: ${String(error)}`));
}

const secretsDir = join(userData, 'secrets');
const secretFile = (name: SecretName) => join(secretsDir, `${name}.bin`);

function requireEncryption() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('이 컴퓨터에서 로그인 정보를 안전하게 저장할 수 없습니다');
}

async function loadSecret(name: SecretName): Promise<string | null> {
  let data: Buffer;
  try { data = await readFile(secretFile(name)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  requireEncryption();
  try { return safeStorage.decryptString(data); }
  catch {
    // An unreadable secret (keychain reset, copied profile) only means the user reconnects.
    await rm(secretFile(name), { force: true });
    log(`저장된 로그인 정보(${name})를 복호화하지 못해 삭제했습니다`);
    return null;
  }
}

async function saveSecret(name: SecretName, value: string) {
  requireEncryption();
  const encrypted = safeStorage.encryptString(value);
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });
  await chmod(secretsDir, 0o700);
  const file = secretFile(name);
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, encrypted, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, file);
}

async function runBridge(request: BridgeRequest): Promise<string | null> {
  switch (request.op) {
    case 'loadSecret': return loadSecret(request.name);
    case 'saveSecret': await saveSecret(request.name, request.value); return null;
    case 'clearSecret': await rm(secretFile(request.name), { force: true }); return null;
    case 'openExternal': {
      const href = externalUrl(request.url, ['https:', 'http:']);
      if (!href) throw new Error('열 수 없는 주소입니다');
      // shell errors may echo the URL (with an OAuth query), so neither it nor the error text is logged.
      try { await shell.openExternal(href); }
      catch { throw new Error('브라우저를 열지 못했습니다'); }
      return null;
    }
    default: return request satisfies never;
  }
}

async function handleBridge(child: UtilityProcess, message: unknown) {
  const parsed = parseBridgeRequest(message);
  let result: BridgeResult;
  if (!parsed.ok) {
    if (parsed.id === null) { log('잘못된 데스크톱 브리지 요청을 무시했습니다'); return; }
    result = { type: 'bridgeResult', id: parsed.id, ok: false, error: parsed.error };
  } else {
    const { id, op } = parsed.request;
    try {
      result = { type: 'bridgeResult', id, ok: true, value: await runBridge(parsed.request) };
    } catch (error) {
      const text = error instanceof Error ? error.message : '알 수 없는 오류';
      log(`데스크톱 브리지 ${op} 실패: ${text}`);
      result = { type: 'bridgeResult', id, ok: false, error: text };
    }
  }
  try { child.postMessage(result); }
  catch { /* The backend already exited. */ }
}

function checkSender(event: IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !isAppUrl(event.senderFrame.url)) {
    throw new Error('허용되지 않은 앱 요청입니다.');
  }
  return window;
}

function settings() {
  void showWindow().then(() => {
    if (!window) return;
    if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', () => window?.webContents.send(IPC.openSettings));
    else window.webContents.send(IPC.openSettings);
  }).catch(fail);
}

function installMenu() {
  // Windows: no menu bar (Alt-drag selects PDF areas and must not pop one up); the page handles Ctrl+,.
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }
  const template: MenuItemConstructorOptions[] = [
    { label: 'PaperLens', submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: '설정…', accelerator: 'CommandOrControl+,', click: settings },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function showWindow() {
  if (quitting || !backendOrigin) return;
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return;
  }
  const browser = new BrowserWindow({
    title: 'PaperLens', width: 1440, height: 960, minWidth: 960, minHeight: 640,
    backgroundColor: themeBackground(), show: false,
    // macOS: the app's header is the title bar. Windows keeps its native frame and window buttons.
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 17 } } : {}),
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
      session: session.fromPartition('paper-reader'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
    },
  });
  window = browser;
  browser.once('closed', () => { if (window === browser) window = null; });
  browser.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  browser.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) { event.preventDefault(); openExternal(url); }
  });
  browser.webContents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  browser.webContents.on('will-attach-webview', event => event.preventDefault());
  browser.webContents.on('render-process-gone', (_event, details) => {
    if (!quitting) void fail(new Error(`앱 화면이 종료되었습니다 (${details.reason}).`));
  });
  browser.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3 && !quitting) void fail(new Error(`화면을 불러오지 못했습니다: ${description}`));
  });
  await browser.loadURL(backendOrigin);
  if (!browser.isDestroyed()) { browser.show(); browser.focus(); }
}

async function startBackend() {
  const root = app.getAppPath();
  for (const file of ['dist/index.html', 'build-desktop/backend.mjs', 'build-desktop/preload.cjs']) {
    if (!existsSync(join(root, file))) throw new Error(`앱 구성 파일이 없습니다: ${file}`);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production', PAPER_READER_APP_ROOT: root, PAPER_READER_DESKTOP: '1',
    PAPER_READER_USER_DATA: userData, PAPER_READER_DB_DIR: storage.dbDir,
    PAPER_READER_FILES: storage.files, PAPER_READER_PARENT_PID: String(process.pid),
  };
  // Finder does not load shell profiles; npm-based CLI launchers still need their Node on PATH.
  // (Windows apps already get the user's PATH from Explorer.)
  if (isMac) env.PATH = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'].join(':');
  // Never let development Node options or Electron's CLI mode change the backend runtime.
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  delete env.ELECTRON_RUN_AS_NODE;
  const child = utilityProcess.fork(join(root, 'build-desktop/backend.mjs'), [], {
    cwd: userData, env, stdio: 'pipe', serviceName: 'PaperLens Backend',
  });
  backend = child;
  child.stdout?.on('data', (chunk: Buffer) => log(`backend: ${chunk.toString('utf8').trimEnd()}`));
  child.stderr?.on('data', (chunk: Buffer) => log(`backend: ${chunk.toString('utf8').trimEnd()}`));
  child.on('exit', code => {
    if (backend === child) backend = null;
    if (!quitting && backendOrigin) void fail(new Error(`백엔드가 종료되었습니다 (코드 ${code}).`));
  });
  // Bridge requests may arrive before `ready` (e.g. sync starting right after the listener opens).
  child.on('message', (message: BackendMessage) => {
    if (message?.type === 'bridge') void handleBridge(child, message);
  });
  const ready = Promise.withResolvers<number>();
  const timeout = setTimeout(() => finish(new Error('백엔드 시작 시간이 초과되었습니다.')), 30_000);
  const onExit = (code: number) => finish(new Error(`백엔드를 시작하지 못했습니다 (코드 ${code}).`));
  const onMessage = (message: BackendMessage) => {
    if (message.type === 'fatal') finish(new Error(message.message));
    else if (message.type === 'ready' && Number.isInteger(message.port) && message.port > 0 && message.port < 65536) finish(null, message.port);
  };
  function finish(error: Error | null, value?: number) {
    clearTimeout(timeout);
    child.off('exit', onExit);
    child.off('message', onMessage);
    if (error) ready.reject(error);
    else if (value !== undefined) ready.resolve(value);
  }
  child.on('exit', onExit);
  child.on('message', onMessage);
  child.once('spawn', () => child.postMessage({ type: 'start', token }));
  const port = await ready.promise;
  backendOrigin = `http://127.0.0.1:${port}`;
  child.on('message', (message: BackendMessage) => {
    if (message.type === 'fatal') void fail(new Error(message.message));
  });
}

async function stopBackend() {
  const child = backend;
  if (!child) return;
  const stopped = Promise.withResolvers<void>();
  const forceKill = setTimeout(() => {
    // utilityProcess.kill uses SIGTERM; escalate only our own child if necessary.
    const pid = child.pid;
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ } }
    finish();
  }, 7_000);
  const terminate = setTimeout(() => child.kill(), 5_500);
  const finish = () => {
    clearTimeout(forceKill);
    clearTimeout(terminate);
    child.off('exit', finish);
    stopped.resolve();
  };
  child.once('exit', finish);
  child.postMessage({ type: 'shutdown' });
  await stopped.promise;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { void showWindow().catch(fail); });
  app.on('activate', () => { void showWindow().catch(fail); });
  // macOS apps stay in the Dock until Quit; on Windows closing the window ends the app (and its backend).
  app.on('window-all-closed', () => { if (!isMac) app.quit(); });
  app.on('before-quit', event => {
    if (mayQuit) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void stopBackend().finally(() => { mayQuit = true; app.quit(); });
  });
  process.on('uncaughtException', error => { void fail(error); });
  process.on('unhandledRejection', error => { void fail(error); });
  void app.whenReady().then(async () => {
    nativeTheme.themeSource = readThemeSource();
    if (startupError) throw startupError;
    log(`PaperLens ${app.getVersion()} (${process.arch}) 시작`);
    installMenu();
    ipcMain.handle(IPC.getInfo, event => { checkSender(event); return info; });
    ipcMain.handle(IPC.chooseDirectory, async event => {
      const owner = checkSender(event);
      const result = await dialog.showOpenDialog(owner, { title: 'Obsidian 볼트 폴더 선택', properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    });
    ipcMain.handle(IPC.reveal, async (event, target: unknown) => {
      checkSender(event);
      const path = target === 'data' ? storage.dbDir : target === 'files' ? storage.files : null;
      if (!path) throw new Error('알 수 없는 위치입니다.');
      const err = await shell.openPath(path);
      if (err) throw new Error(err);
    });
    ipcMain.handle(IPC.getTheme, event => { checkSender(event); return nativeTheme.themeSource; });
    ipcMain.handle(IPC.setTheme, (event, value: unknown) => {
      checkSender(event);
      if (!isThemeSource(value)) throw new Error('알 수 없는 화면 모드입니다.');
      nativeTheme.themeSource = value;
      writeFileSync(themeFile, JSON.stringify({ theme: value }), { mode: 0o600 });
    });
    nativeTheme.on('updated', () => {
      if (window && !window.isDestroyed()) window.setBackgroundColor(themeBackground());
    });
    await startBackend();
    const appSession = session.fromPartition('paper-reader');
    appSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    appSession.setPermissionCheckHandler(() => false);
    appSession.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      const headers = details.requestHeaders;
      // A redirect must never carry the session credential to a different origin.
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'authorization' && (isAppUrl(details.url) || headers[key].includes(token))) delete headers[key];
      }
      if (isAppUrl(details.url)) headers.Authorization = `Bearer ${token}`;
      callback({ requestHeaders: headers });
    });
    await showWindow();
  }).catch(fail);
}
