import type { DesktopInfo } from '../desktop/protocol';

export type { DesktopInfo } from '../desktop/protocol';

declare global {
  interface Window {
    paperReaderDesktop?: {
      platform: NodeJS.Platform;
      chooseDirectory(): Promise<string | null>;
      getInfo(): Promise<DesktopInfo>;
      reveal(target: 'data' | 'files'): Promise<void>;
      /** The saved 화면 모드; the app's web storage does not outlive a launch, so the main process keeps it. */
      getTheme(): Promise<'system' | 'light' | 'dark'>;
      setTheme(pref: 'system' | 'light' | 'dark'): Promise<void>;
      onOpenSettings(handler: () => void): () => void;
    };
  }
}
