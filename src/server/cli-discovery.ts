import { posix, win32 } from 'node:path';
import type { EngineId } from '../shared/models';

export interface CliDiscoveryContext {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  isExecutable(path: string): boolean;
}
export interface CliLocation {
  path: string;
  source: 'path' | 'install-dir' | 'fallback';
}

/** PATH order wins, then explicit installer directory, then GUI-launch fallbacks. Never choose by version. */
export function discoverCliLocation(engine: EngineId, context: CliDiscoveryContext): CliLocation | null {
  const { platform, home, env, isExecutable } = context;
  const windows = platform === 'win32';
  const path = windows ? win32 : posix;
  const names = windows
    ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter((ext) => /^\.[a-z]+$/i.test(ext)).map((ext) => engine + ext.toLowerCase())
    : [engine];
  for (const entry of (env.PATH || '').split(windows ? ';' : ':')) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!path.isAbsolute(dir)) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return { path: candidate, source: 'path' };
    }
  }
  if (engine === 'codex' && env.CODEX_INSTALL_DIR && path.isAbsolute(env.CODEX_INSTALL_DIR)) {
    const candidate = path.join(env.CODEX_INSTALL_DIR, windows ? 'codex.exe' : 'codex');
    if (isExecutable(candidate)) return { path: candidate, source: 'install-dir' };
  }
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const candidates = windows
    ? [path.join(home, '.local', 'bin', `${engine}.exe`), path.join(appData, 'npm', `${engine}.cmd`), ...(engine === 'codex' ? [path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')] : [])]
    : [path.join(home, '.local', 'bin', engine), `/opt/homebrew/bin/${engine}`, `/usr/local/bin/${engine}`];
  for (const candidate of candidates) if (isExecutable(candidate)) return { path: candidate, source: 'fallback' };
  return null;
}
