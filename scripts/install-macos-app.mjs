import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('macOS 앱 설치는 macOS에서만 가능합니다.');

const root = fileURLToPath(new URL('../', import.meta.url));
const name = 'Paper Reader';
const bundleId = 'io.github.ixon27.paper-reader';
const app = join(homedir(), 'Applications', `${name}.app`);
const shortcut = join(homedir(), 'Desktop', `${name}.app`);
const infoFile = join(app, 'Contents', 'Info.plist');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
// Homebrew's stable symlink survives upgrades; process.execPath points into a versioned Cellar dir.
const node = ['/opt/homebrew/bin/node', '/usr/local/bin/node', process.execPath].find(path => existsSync(path));

// Reinstallation may replace only an application created by this installer.
if (existsSync(app)) {
  let existingId;
  try {
    existingId = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoFile], { encoding: 'utf8' }).trim();
  } catch {
    existingId = '';
  }
  if (existingId !== bundleId) throw new Error(`${app} 에 다른 앱이 있습니다. 덮어쓰지 않았습니다.`);
}

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const command = `${quote(node)} ${quote(join(root, 'scripts', 'launch.mjs'))}`;
const script = `on run
  try
    with timeout of 40 seconds
      do shell script ${JSON.stringify(command)}
    end timeout
  on error detail
    display alert "Paper Reader를 열지 못했습니다" message detail as critical buttons {"확인"} default button "확인"
  end try
end run`;

const staging = mkdtempSync(join(tmpdir(), 'paper-reader-app-'));
try {
  const stagedApp = join(staging, `${name}.app`);
  execFileSync('/usr/bin/osacompile', ['-o', stagedApp, '-e', script]);
  const plist = join(stagedApp, 'Contents', 'Info.plist');
  for (const [key, value] of Object.entries({ CFBundleName: name, CFBundleDisplayName: name, CFBundleIdentifier: bundleId, CFBundleShortVersionString: version })) {
    execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, plist]);
  }
  execFileSync('/usr/bin/plutil', ['-replace', 'LSUIElement', '-bool', 'YES', plist]);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', stagedApp], { stdio: 'inherit' });
  mkdirSync(join(homedir(), 'Applications'), { recursive: true });
  if (existsSync(app)) rmSync(app, { recursive: true });
  cpSync(stagedApp, app, { recursive: true });

  let desktopExists = false;
  try {
    lstatSync(shortcut);
    desktopExists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!desktopExists) symlinkSync(app, shortcut, 'dir');
  else if (!lstatSync(shortcut).isSymbolicLink() || readlinkSync(shortcut) !== app) {
    console.log(`바탕화면에 같은 이름의 항목이 있어 바로가기는 만들지 않았습니다: ${shortcut}`);
  }
  console.log(`설치됨: ${app}`);
  console.log('바탕화면의 Paper Reader를 더블클릭하세요. Dock에 끌어다 놓아도 됩니다.');
  console.log('저장소를 옮겼거나 Node 경로가 바뀌면 npm run install:app 으로 다시 설치하세요.');
} finally {
  rmSync(staging, { recursive: true, force: true });
}
