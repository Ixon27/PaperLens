export interface DesktopInfo {
  version: string;
  dataDir: string;
  filesDir: string;
  logDir: string;
}

export const IPC = {
  chooseDirectory: 'paper-reader:choose-directory',
  getInfo: 'paper-reader:get-info',
  openSettings: 'paper-reader:open-settings',
} as const;

export type ParentMessage = { type: 'shutdown' } | { type: 'start'; token: string };
export type BackendMessage = { type: 'ready'; port: number } | { type: 'fatal'; message: string };
