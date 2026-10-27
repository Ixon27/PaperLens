import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

interface Command {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** npm shims can point to a Node script or a native executable (current Claude). */
const SHIM_TARGET = /"%~?dp0%?\\(node_modules\\[^"]+\.(?:(?:c|m)?js|exe))"/i;

function nodeFor(shim: string): Command {
  const beside = join(dirname(shim), 'node.exe');
  if (existsSync(beside)) return { command: beside, args: [], env: {} };
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, 'node.exe'))) return { command: join(dir, 'node.exe'), args: [], env: {} };
  }
  // No Node on PATH: the app's own runtime runs the script (Electron as Node).
  return { command: process.execPath, args: [], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/**
 * What to execute for a CLI path. An npm-installed CLI on Windows is a `.cmd` shim, which Node can only
 * start through cmd.exe, and cmd.exe mangles JSON and quoted arguments; run the package's entrypoint
 * directly (under Node for scripts).
 */
export function resolveCli(bin: string, platform = process.platform): Command {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(bin)) return { command: bin, args: [], env: {} };
  const target = SHIM_TARGET.exec(readFileSync(bin, 'utf8'))?.[1];
  if (!target) throw new Error(`CLI 실행 파일을 해석하지 못했습니다: ${bin}`);
  if (/\.exe$/i.test(target)) return { command: join(dirname(bin), target), args: [], env: {} };
  const node = nodeFor(bin);
  return { ...node, args: [join(dirname(bin), target)] };
}

export function spawnCli(bin: string, args: string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams {
  const target = resolveCli(bin);
  return spawn(target.command, [...target.args, ...args], {
    ...options,
    env: { ...process.env, ...target.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/** Stop a CLI and whatever it started (Windows has no process groups: a script's own children would survive). */
export function stopCli(child: { pid?: number; exitCode: number | null; kill(signal?: NodeJS.Signals): boolean }) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
  } else {
    child.kill('SIGTERM');
  }
}
