import { createContext, useCallback, useContext, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { Highlight, PdfHighlighterUtils } from 'react-pdf-highlighter-extended';
import type { AskInput, BlockDto } from '../types';

export type TabId = 'translation' | 'analysis' | 'chat' | 'mindmap' | 'citations' | 'highlights';
export type PdfMode = 'split' | 'full-panel';
export type PendingAsk = AskInput & { nonce: number };

export interface ViewerState {
  utilsRef: MutableRefObject<PdfHighlighterUtils | null>;
  /** Scroll the PDF to page n (switches back to split view first if the PDF is hidden). */
  jumpToPage(n: number): void;
  scrollToBlock(b: BlockDto): void;
  hoverBlock: BlockDto | null;
  setHoverBlock(b: BlockDto | null): void;
  /** Updated by PdfPane from the viewer eventBus 'pagechanging' event. */
  currentPage: number;
  setCurrentPage(n: number): void;
  numPages: number;
  setNumPages(n: number): void;
  /** Switch to the chat tab and send `input` there. */
  requestAsk(input: AskInput): void;
  /** The latest requestAsk input not yet consumed by ChatPanel. */
  pendingAsk: PendingAsk | null;
  takePendingAsk(nonce: number): void;
  tab: TabId;
  setTab(t: TabId): void;
  pdfMode: PdfMode;
  setPdfMode(m: PdfMode): void;
}

const ViewerContext = createContext<ViewerState | null>(null);

export const BLOCK_HIGHLIGHT_ID = '__block';

/** Highlight covering a block's lines. Top-left PDF points are already the lib's `Scaled` space. */
export function blockHighlight(b: BlockDto): Highlight {
  const rects = b.lines.map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2, width: b.pageW, height: b.pageH, pageNumber: b.page }));
  const boundingRect = {
    x1: Math.min(...rects.map((r) => r.x1)),
    y1: Math.min(...rects.map((r) => r.y1)),
    x2: Math.max(...rects.map((r) => r.x2)),
    y2: Math.max(...rects.map((r) => r.y2)),
    width: b.pageW,
    height: b.pageH,
    pageNumber: b.page,
  };
  return { id: BLOCK_HIGHLIGHT_ID, type: 'text', position: { boundingRect, rects } };
}

const TAB_KEY = 'pr.tab';
const TABS: TabId[] = ['translation', 'analysis', 'chat', 'mindmap', 'citations', 'highlights'];

export function ViewerProvider({ children }: { children: ReactNode }) {
  const utilsRef = useRef<PdfHighlighterUtils | null>(null);
  const [hoverBlock, setHoverBlock] = useState<BlockDto | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null);
  const [pdfMode, setPdfMode] = useState<PdfMode>('split');
  const [tab, setTabState] = useState<TabId>(() => {
    const saved = localStorage.getItem(TAB_KEY) as TabId | null;
    return saved && TABS.includes(saved) ? saved : 'translation';
  });
  const pdfModeRef = useRef(pdfMode);
  pdfModeRef.current = pdfMode;

  const setTab = useCallback((t: TabId) => {
    localStorage.setItem(TAB_KEY, t);
    setTabState(t);
  }, []);

  const jumpToPage = useCallback((n: number) => {
    const go = () => {
      const viewer = utilsRef.current?.getViewer();
      if (viewer && n >= 1 && n <= viewer.pagesCount) viewer.currentPageNumber = n;
    };
    if (pdfModeRef.current === 'full-panel') {
      setPdfMode('split');
      // wait for the PDF column to be laid out again before scrolling
      setTimeout(go, 150);
    } else {
      go();
    }
  }, []);

  const scrollToBlock = useCallback((b: BlockDto) => {
    utilsRef.current?.scrollToHighlight(blockHighlight(b));
  }, []);

  const requestAsk = useCallback(
    (input: AskInput) => {
      setPendingAsk({ ...input, nonce: Date.now() + Math.random() });
      setTab('chat');
    },
    [setTab],
  );

  const takePendingAsk = useCallback((nonce: number) => {
    setPendingAsk((p) => (p && p.nonce === nonce ? null : p));
  }, []);

  const value = useMemo<ViewerState>(
    () => ({
      utilsRef,
      jumpToPage,
      scrollToBlock,
      hoverBlock,
      setHoverBlock,
      currentPage,
      setCurrentPage,
      numPages,
      setNumPages,
      requestAsk,
      pendingAsk,
      takePendingAsk,
      tab,
      setTab,
      pdfMode,
      setPdfMode,
    }),
    [jumpToPage, scrollToBlock, hoverBlock, currentPage, numPages, requestAsk, pendingAsk, takePendingAsk, tab, setTab, pdfMode],
  );
  return <ViewerContext.Provider value={value}>{children}</ViewerContext.Provider>;
}

export function useViewer(): ViewerState {
  const v = useContext(ViewerContext);
  if (!v) throw new Error('useViewer must be used inside ViewerProvider');
  return v;
}
