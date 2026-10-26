import type { DesktopInfo } from '../desktop/protocol';

export type { DesktopInfo } from '../desktop/protocol';

declare global {
  interface Window {
    paperReaderDesktop?: {
      chooseDirectory(): Promise<string | null>;
      getInfo(): Promise<DesktopInfo>;
      onOpenSettings(handler: () => void): () => void;
    };
  }
}
