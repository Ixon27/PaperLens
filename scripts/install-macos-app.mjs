import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('macOS 앱 설치는 macOS에서만 가능합니다.');

const root = fileURLToPath(new URL('../', import.meta.url));
const name = 'Paper Reader';
const bundleId = 'io.github.ixon27.paper-reader';
const source = resolve(process.argv[2] ?? join(root, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', `${name}.app`));
const app = join(homedir(), 'Applications', `${name}.app`);
const shortcut = join(homedir(), 'Desktop', `${name}.app`);

function bundleIdentifier(path) {
  try {
    return execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(path, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function entryExists(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

if (source === app || bundleIdentifier(source) !== bundleId || !existsSync(join(source, 'Contents', 'Resources', 'app.asar'))) {
  throw new Error(`정상적인 Electron 앱 빌드가 아닙니다: ${source}\nnpm run pack:mac 으로 먼저 앱을 빌드하세요.`);
}
if (entryExists(app) && (lstatSync(app).isSymbolicLink() || bundleIdentifier(app) !== bundleId)) {
  throw new Error(`${app} 에 다른 앱이나 바로가기가 있습니다. 덮어쓰지 않았습니다.`);
}
// Never terminate the user's app or any CLI jobs during an installation.
const executablePattern = `^${app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/Contents/MacOS/`;
let running = false;
try {
  execFileSync('/usr/bin/pgrep', ['-f', executablePattern], { stdio: 'ignore' });
  running = true;
} catch (error) {
  if (error.status !== 1) throw error;
}
if (running) throw new Error('실행 중인 Paper Reader를 Cmd+Q로 종료한 뒤 다시 설치하세요. 앱이나 작업을 강제로 종료하지 않았습니다.');

mkdirSync(dirname(app), { recursive: true });
const staging = mkdtempSync(join(dirname(app), '.paper-reader-install-'));
const stagedApp = join(staging, `${name}.app`);
const backup = join(staging, 'previous.app');
try {
  // ditto preserves the signed app's bundle metadata and resource forks.
  execFileSync('/usr/bin/ditto', [source, stagedApp], { stdio: 'inherit' });
  let backedUp = false;
  if (entryExists(app)) { renameSync(app, backup); backedUp = true; }
  try {
    renameSync(stagedApp, app);
  } catch (error) {
    if (backedUp) renameSync(backup, app);
    throw error;
  }
  mkdirSync(dirname(shortcut), { recursive: true });
  if (!entryExists(shortcut)) symlinkSync(app, shortcut, 'dir');
  else if (!lstatSync(shortcut).isSymbolicLink() || resolve(dirname(shortcut), readlinkSync(shortcut)) !== app) {
    console.log(`바탕화면에 같은 이름의 항목이 있어 그대로 두었습니다: ${shortcut}`);
  }
  console.log(`설치됨: ${app}`);
  console.log('바탕화면이나 응용 프로그램 폴더에서 Paper Reader를 여세요. Node·브라우저·원본 저장소는 필요하지 않습니다.');
} finally {
  rmSync(staging, { recursive: true, force: true });
}
