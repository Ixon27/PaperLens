import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { Highlight, PdfHighlighterUtils } from 'react-pdf-highlighter-extended';
import { rangesFor, showSource } from '../pdf/syncHighlight';
import type { AskInput, BlockDto } from '../types';

export type TabId = 'overview' | 'analysis' | 'figures' | 'mindmap' | 'lineage' | 'citations' | 'highlights';
export type PdfMode = 'split' | 'full-panel';
export type PendingAsk = AskInput & { nonce: number };

export interface ViewerState {
  utilsRef: MutableRefObject<PdfHighlighterUtils | null>;
  /** Scroll the PDF to page n (switches back to split view first if the PDF is hidden). */
  jumpToPage(n: number): void;
  scrollToBlock(b: BlockDto): void;
  revealSource(block: BlockDto, start: number, end: number): void;
  /** Updated by PdfPane from the viewer eventBus 'pagechanging' event. */
  currentPage: number;
  setCurrentPage(n: number): void;
  numPages: number;
  setNumPages(n: number): void;
  /** Open 요약·토론 and send `input` to 토론. */
  requestAsk(input: AskInput): void;
  /** The latest requestAsk input not yet consumed by 토론. */
  pendingAsk: PendingAsk | null;
  takePendingAsk(nonce: number): void;
  figureFocus: { anchor: string; autoStart: boolean; nonce: number } | null;
  openFigure(anchor: string, autoStart: boolean): void;
  takeFigureFocus(nonce: number): void;
  tab: TabId;
  setTab(t: TabId): void;
  pdfMode: PdfMode;
  setPdfMode(m: PdfMode): void;
  /** Translation pane right of the PDF. */
  showTranslation: boolean;
  setShowTranslation(on: boolean): void;
  /** Right sidebar (the tab panels); the icon rail stays visible. */
  sidebarOpen: boolean;
  setSidebarOpen(on: boolean): void;
  /** Open 요약·토론 and bring its 키워드 사전 into view. */
  showKeywords(): void;
  /** Bumped by showKeywords. */
  keywordsFocus: number;
  /** Bumped whenever a term is saved, so the 키워드 사전 reloads. */
  termsVersion: number;
  bumpTerms(): void;
}

const ViewerContext = createContext<ViewerState | null>(null);

export const BLOCK_HIGHLIGHT_ID = '__block';

/**
 * Highlight covering a block's lines. Top-left PDF points are already the lib's `Scaled` space.
 * A paragraph continued on the next page carries that page on its later lines.
 */
export function blockHighlight(b: BlockDto): Highlight {
  const rects = b.lines.map(([x1, y1, x2, y2, page]) => ({ x1, y1, x2, y2, width: b.pageW, height: b.pageH, pageNumber: page ?? b.page }));
  const first = rects.filter((r) => r.pageNumber === b.page);
  const boundingRect = {
    x1: Math.min(...first.map((r) => r.x1)),
    y1: Math.min(...first.map((r) => r.y1)),
    x2: Math.max(...first.map((r) => r.x2)),
    y2: Math.max(...first.map((r) => r.y2)),
    width: b.pageW,
    height: b.pageH,
    pageNumber: b.page,
  };
  return { id: BLOCK_HIGHLIGHT_ID, type: 'text', position: { boundingRect, rects } };
}

const TAB_KEY = 'pr.tab';
const TABS: TabId[] = ['overview', 'analysis', 'figures', 'mindmap', 'lineage', 'citations', 'highlights'];

function storedTab(): TabId {
  const saved = localStorage.getItem(TAB_KEY);
  // 채팅 was its own tab before 요약·토론 took it in.
  if (saved === 'chat') return 'overview';
  return TABS.find((t) => t === saved) ?? 'overview';
}

/** A boolean kept in localStorage across papers and launches. */
function useStoredFlag(key: string, fallback: boolean): [boolean, (on: boolean) => void] {
  const [value, setValue] = useState(() => {
    const saved = localStorage.getItem(key);
    return saved === null ? fallback : saved === '1';
  });
  const set = useCallback(
    (on: boolean) => {
      localStorage.setItem(key, on ? '1' : '0');
      setValue(on);
    },
    [key],
  );
  return [value, set];
}

export function ViewerProvider({ children }: { children: ReactNode }) {
  const utilsRef = useRef<PdfHighlighterUtils | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null);
  const [figureFocus, setFigureFocus] = useState<ViewerState['figureFocus']>(null);
  const [pdfMode, setPdfMode] = useState<PdfMode>('split');
  const [showTranslation, setShowTranslation] = useStoredFlag('pr.showTranslation', true);
  const [sidebarOpen, setSidebarOpen] = useStoredFlag('pr.sidebarOpen', true);
  const [keywordsFocus, setKeywordsFocus] = useState(0);
  const [termsVersion, setTermsVersion] = useState(0);
  const bumpTerms = useCallback(() => setTermsVersion((v) => v + 1), []);
  const [tab, setTabState] = useState<TabId>(storedTab);
  const tabRef = useRef(tab);
  const pdfModeRef = useRef(pdfMode);
  pdfModeRef.current = pdfMode;
  const sourceCleanup = useRef<(() => void) | null>(null);
  const sourceTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    sourceCleanup.current?.();
    clearTimeout(sourceTimer.current);
    showSource([]);
  }, []);

  const setTab = useCallback((t: TabId) => {
    if (t !== tabRef.current) {
      tabRef.current = t;
      setPdfMode('split');
    }
    localStorage.setItem(TAB_KEY, t);
    setTabState(t);
  }, []);

  const jumpToPage = useCallback((n: number) => {
    const go = () => {
      const viewer = utilsRef.current?.getViewer();
      if (viewer && n >= 1 && n <= viewer.pagesCount) viewer.currentPageNumber = n;
    };
    if (pdfModeRef.current === 'full-panel') setPdfMode('split');
    go();
  }, []);

  const scrollToBlock = useCallback((b: BlockDto) => {
    utilsRef.current?.scrollToHighlight(blockHighlight(b));
  }, []);

  const revealSource = useCallback((block: BlockDto, start: number, end: number) => {
    sourceCleanup.current?.();
    clearTimeout(sourceTimer.current);
    showSource([]);
    const go = () => {
      sourceCleanup.current = null;
      scrollToBlock(block);
      const paint = () => {
        const ranges = rangesFor(block, start, end);
        if (!ranges.length) return false;
        showSource(ranges);
        sourceTimer.current = window.setTimeout(() => {
          showSource([]);
          sourceTimer.current = undefined;
        }, 6000);
        return true;
      };
      if (paint()) return;
      const viewer = utilsRef.current?.getViewer();
      if (!viewer) return;
      const cleanup = () => {
        viewer.eventBus.off('textlayerrendered', onRendered);
        clearTimeout(timeout);
        if (sourceCleanup.current === cleanup) sourceCleanup.current = null;
      };
      const onRendered = (e: { pageNumber: number }) => {
        if (e.pageNumber === block.page) {
          paint();
          cleanup();
        }
      };
      viewer.eventBus.on('textlayerrendered', onRendered);
      const timeout = setTimeout(cleanup, 5000);
      sourceCleanup.current = cleanup;
    };
    if (pdfModeRef.current === 'full-panel') {
      setPdfMode('split');
      const frame = requestAnimationFrame(go);
      sourceCleanup.current = () => cancelAnimationFrame(frame);
    } else go();
  }, [scrollToBlock]);

  const requestAsk = useCallback(
    (input: AskInput) => {
      setPendingAsk({ ...input, nonce: Date.now() + Math.random() });
      setTab('overview');
      setSidebarOpen(true);
    },
    [setTab, setSidebarOpen],
  );

  const showKeywords = useCallback(() => {
    setTab('overview');
    setSidebarOpen(true);
    setKeywordsFocus((n) => n + 1);
  }, [setTab, setSidebarOpen]);

  const takePendingAsk = useCallback((nonce: number) => {
    setPendingAsk((p) => (p && p.nonce === nonce ? null : p));
  }, []);

  const openFigure = useCallback((anchor: string, autoStart: boolean) => {
    setFigureFocus({ anchor, autoStart, nonce: Date.now() + Math.random() });
    setTab('figures');
    setSidebarOpen(true);
  }, [setTab, setSidebarOpen]);
  const takeFigureFocus = useCallback((nonce: number) => {
    setFigureFocus((focus) => focus?.nonce === nonce ? null : focus);
  }, []);

  const value = useMemo<ViewerState>(
    () => ({
      utilsRef,
      jumpToPage,
      scrollToBlock,
      revealSource,
      currentPage,
      setCurrentPage,
      numPages,
      setNumPages,
      requestAsk,
      pendingAsk,
      takePendingAsk,
      figureFocus,
      openFigure,
      takeFigureFocus,
      tab,
      setTab,
      pdfMode,
      setPdfMode,
      showTranslation,
      setShowTranslation,
      sidebarOpen,
      setSidebarOpen,
      showKeywords,
      keywordsFocus,
      termsVersion,
      bumpTerms,
    }),
    [
      jumpToPage,
      scrollToBlock,
      revealSource,
      currentPage,
      numPages,
      requestAsk,
      pendingAsk,
      takePendingAsk,
      figureFocus,
      openFigure,
      takeFigureFocus,
      tab,
      setTab,
      pdfMode,
      showTranslation,
      setShowTranslation,
      sidebarOpen,
      setSidebarOpen,
      showKeywords,
      keywordsFocus,
      termsVersion,
      bumpTerms,
    ],
  );
  return <ViewerContext.Provider value={value}>{children}</ViewerContext.Provider>;
}

export function useViewer(): ViewerState {
  const v = useContext(ViewerContext);
  if (!v) throw new Error('useViewer must be used inside ViewerProvider');
  return v;
}
