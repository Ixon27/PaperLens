import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from './protocol';
import type { DesktopInfo } from './protocol';

contextBridge.exposeInMainWorld('paperReaderDesktop', Object.freeze({
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC.chooseDirectory),
  getInfo: (): Promise<DesktopInfo> => ipcRenderer.invoke(IPC.getInfo),
  onOpenSettings(handler: () => void) {
    if (typeof handler !== 'function') throw new TypeError('설정 핸들러는 함수여야 합니다.');
    const listener = () => handler();
    ipcRenderer.on(IPC.openSettings, listener);
    return () => { ipcRenderer.removeListener(IPC.openSettings, listener); };
  },
}));
