export function engineLabel(e?: string | null): string {
  if (e === 'claude') return 'Claude';
  if (e === 'codex') return 'Codex';
  return e ?? '';
}

export const EFFORT_LABELS: Record<string, string> = {
  '': 'CLI 기본값 (수준 알 수 없음)',
  auto: 'CLI 기본값 (수준 알 수 없음)',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'ultra',
};

export const effortLabel = (v: string): string => EFFORT_LABELS[v] ?? v;

/** Shows `home`-relative paths as `~/…`. */
export function displayPath(path: string, home: string): string {
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

/** macOS shows key glyphs (⌘, ⌥); Windows names the keys. */
export const isMac = /Mac/.test(navigator.platform || navigator.userAgent);
export const ALT_KEY = isMac ? '⌥' : 'Alt';
export const SETTINGS_SHORTCUT = isMac ? '⌘,' : 'Ctrl+,';
export const OS_NAME = isMac ? 'macOS' : 'Windows';
export const FILE_MANAGER = isMac ? 'Finder' : '탐색기';
export const THIS_COMPUTER = isMac ? '이 Mac' : '이 PC';
