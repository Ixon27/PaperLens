export interface DesktopInfo {
  version: string;
  dataDir: string;
  filesDir: string;
  logDir: string;
}

export const IPC = {
  chooseDirectory: 'paper-reader:choose-directory',
  getInfo: 'paper-reader:get-info',
  getTheme: 'paper-reader:get-theme',
  openSettings: 'paper-reader:open-settings',
  reveal: 'paper-reader:reveal',
  setTheme: 'paper-reader:set-theme',
} as const;

export type ParentMessage = { type: 'shutdown' } | { type: 'start'; token: string };
export type BackendMessage = { type: 'ready'; port: number } | { type: 'fatal'; message: string };
