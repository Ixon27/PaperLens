import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, utilityProcess } from 'electron';
import type { IpcMainInvokeEvent, MenuItemConstructorOptions, UtilityProcess } from 'electron';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStoragePaths } from '../shared/storage';
import { IPC } from './protocol';
import type { BackendMessage, DesktopInfo } from './protocol';

app.setName('Paper Reader');
const requestedUserData = process.env.PAPER_READER_USER_DATA ?? join(homedir(), 'Library', 'Application Support', 'paper-reader');
const userData = requestedUserData === '~' || requestedUserData.startsWith('~/') ? join(homedir(), requestedUserData.slice(1)) : requestedUserData;
const logDir = join(homedir(), 'Library', 'Logs', 'paper-reader');
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

function log(message: string) {
  const safe = message.replaceAll(token, '[redacted]');
  try { appendFileSync(logFile, `${new Date().toISOString()} ${safe}\n`, { mode: 0o600 }); }
  catch { console.error(safe); }
}

async function fail(error: unknown) {
  log(error instanceof Error ? error.stack ?? error.message : String(error));
  if (failureShown || quitting) return;
  failureShown = true;
  dialog.showErrorBox('Paper Reader를 열지 못했습니다', `앱을 종료한 뒤 다시 실행해 주세요. 문제가 계속되면 로그를 확인해 주세요.\n\n${error instanceof Error ? error.message.replaceAll(token, '[redacted]') : '알 수 없는 오류'}\n\n로그: ${logFile}`);
  app.quit();
}

function isAppUrl(value: string) {
  try { return Boolean(backendOrigin) && new URL(value).origin === backendOrigin; }
  catch { return false; }
}

function openExternal(value: string) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:', 'obsidian:'].includes(url.protocol) || url.username || url.password || isAppUrl(value)) return;
    void shell.openExternal(url.href).catch(error => log(`외부 링크 열기 실패: ${String(error)}`));
  } catch { /* Malformed links must never reach the OS. */ }
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
  const template: MenuItemConstructorOptions[] = [
    { label: 'Paper Reader', submenu: [
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
    title: 'Paper Reader', width: 1440, height: 960, minWidth: 960, minHeight: 640,
    backgroundColor: '#f8fafc', show: false,
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
  env.PATH = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'].join(':');
  // Never let development Node options or Electron's CLI mode change the backend runtime.
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  delete env.ELECTRON_RUN_AS_NODE;
  const child = utilityProcess.fork(join(root, 'build-desktop/backend.mjs'), [], {
    cwd: userData, env, stdio: 'pipe', serviceName: 'Paper Reader Backend',
  });
  backend = child;
  child.stdout?.on('data', (chunk: Buffer) => log(`backend: ${chunk.toString('utf8').trimEnd()}`));
  child.stderr?.on('data', (chunk: Buffer) => log(`backend: ${chunk.toString('utf8').trimEnd()}`));
  child.on('exit', code => {
    if (backend === child) backend = null;
    if (!quitting && backendOrigin) void fail(new Error(`백엔드가 종료되었습니다 (코드 ${code}).`));
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
  app.on('window-all-closed', () => { /* Native macOS apps remain in the Dock until Quit. */ });
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
    if (startupError) throw startupError;
    log(`Paper Reader ${app.getVersion()} (${process.arch}) 시작`);
    installMenu();
    ipcMain.handle(IPC.getInfo, event => { checkSender(event); return info; });
    ipcMain.handle(IPC.chooseDirectory, async event => {
      const owner = checkSender(event);
      const result = await dialog.showOpenDialog(owner, { title: 'Obsidian 볼트 폴더 선택', properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : result.filePaths[0] ?? null;
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
