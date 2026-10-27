import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from './protocol';
import type { DesktopInfo } from './protocol';

contextBridge.exposeInMainWorld('paperReaderDesktop', Object.freeze({
  platform: process.platform,
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC.chooseDirectory),
  getInfo: (): Promise<DesktopInfo> => ipcRenderer.invoke(IPC.getInfo),
  reveal: (target: 'data' | 'files'): Promise<void> => ipcRenderer.invoke(IPC.reveal, target),
  getTheme: (): Promise<'system' | 'light' | 'dark'> => ipcRenderer.invoke(IPC.getTheme),
  setTheme: (pref: 'system' | 'light' | 'dark'): Promise<void> => ipcRenderer.invoke(IPC.setTheme, pref),
  onOpenSettings(handler: () => void) {
    if (typeof handler !== 'function') throw new TypeError('설정 핸들러는 함수여야 합니다.');
    const listener = () => handler();
    ipcRenderer.on(IPC.openSettings, listener);
    return () => { ipcRenderer.removeListener(IPC.openSettings, listener); };
  },
}));
