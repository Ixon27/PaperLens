import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { PdfHighlighter, PdfLoader, type Highlight, type PdfHighlighterUtils, type PdfScaleValue } from 'react-pdf-highlighter-extended';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Minus, Plus } from 'lucide-react';
import type { PDFViewer } from 'pdfjs-dist/types/web/pdf_viewer';
import { chipCls, iconBtnCls } from '../components/Dialog';
import { usePaper } from '../state/paper';
import { useSyncHover } from '../state/syncHover';
import { useViewer } from '../state/viewer';
import type { BlockDto, HighlightDto, HighlightPosition } from '../types';
import { HighlightContainer, type AppHighlight } from './HighlightContainer';
import { SelectionTip } from './SelectionTip';
import { detectBareNumber, detectCitation, type CiteHit } from './citation';
import { CitationPopover, type PopoverPos } from './CitationPopover';
import { ExplainLayer } from './ExplainLayer';
import { hitTest, rangesFor, showSync } from './syncHighlight';
import { ALT_KEY } from '../labels';

/** Nearest sibling text-layer span (pdf.js interleaves `<br>`s between lines). */
function siblingSpan(el: Element, dir: 'prev' | 'next'): HTMLElement | null {
  let s = dir === 'prev' ? el.previousElementSibling : el.nextElementSibling;
  while (s && s.tagName !== 'SPAN') s = dir === 'prev' ? s.previousElementSibling : s.nextElementSibling;
  return s instanceof HTMLElement ? s : null;
}

/** Index of the character of `span` drawn under (x, y), measured glyph by glyph. */
function charIndexAt(span: HTMLElement, x: number, y: number): number | null {
  const text = span.firstChild;
  if (!text || text.nodeType !== Node.TEXT_NODE) return null;
  const range = document.createRange();
  const len = text.textContent?.length ?? 0;
  for (let i = 0; i < len; i++) {
    range.setStart(text, i);
    range.setEnd(text, i + 1);
    const r = range.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i;
  }
  return null;
}

/** Character offset of the click inside `span`'s text, or null when the caret is not in it. */
function caretOffsetIn(span: HTMLElement, x: number, y: number): number | null {
  let node: Node | null = null;
  let offset = 0;
  if (typeof document.caretPositionFromPoint === 'function') {
    const p = document.caretPositionFromPoint(x, y);
    if (p) {
      node = p.offsetNode;
      offset = p.offset;
    }
  } else if (typeof document.caretRangeFromPoint === 'function') {
    const r = document.caretRangeFromPoint(x, y);
    if (r) {
      node = r.startContainer;
      offset = r.startOffset;
    }
  }
  // A pdf.js link (annotation layer) over the citation swallows the caret hit test.
  if (!node || !span.contains(node)) return charIndexAt(span, x, y);
  const range = document.createRange();
  range.setStart(span, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** Text-layer span under the click — also when a pdf.js link annotation sits on top of it. */
function textSpanAt(e: React.MouseEvent): HTMLElement | null {
  const direct = e.target instanceof Element ? e.target.closest('.textLayer span') : null;
  if (direct instanceof HTMLElement) return direct;
  if (!(e.target instanceof Element) || !e.target.closest('.annotationLayer')) return null;
  const under = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.matches('.textLayer span'));
  return under instanceof HTMLElement ? under : null;
}

/** Citation under a plain click on the PDF text layer (plan step 10 "Click handling"). */
function citationAtClick(e: React.MouseEvent): CiteHit | null {
  const span = textSpanAt(e);
  if (!span) return null;
  const prev = siblingSpan(span, 'prev');
  const next = siblingSpan(span, 'next');
  const prevText = prev?.textContent ?? '';
  const offset = caretOffsetIn(span, e.clientX, e.clientY);
  if (offset !== null) {
    const hit = detectCitation(prevText + (span.textContent ?? '') + (next?.textContent ?? ''), prevText.length + offset);
    if (hit) return hit;
  }
  if (prev && span.getBoundingClientRect().height < 0.8 * prev.getBoundingClientRect().height) {
    const keys = detectBareNumber(span.textContent ?? '');
    if (keys) return { kind: 'numeric', keys };
  }
  return null;
}

/** Saved highlight → the lib's Highlight shape, carrying our fields along. */
export function toAppHighlight(h: HighlightDto): AppHighlight {
  return { id: h.id, type: h.type, position: h.position, color: h.color, note: h.note, text: h.text };
}

const clampScale = (s: number) => Math.min(3, Math.max(0.5, Math.round(s * 10) / 10));

/** Keep sentence hover separate from the PDF viewer; never replace missing alignment with a whole-block highlight. */
function SyncHoverBridge({ paneRef, enabled }: { paneRef: RefObject<HTMLDivElement | null>; enabled: boolean }) {
  const { blocks } = usePaper();
  const { hover, setHover, clearHover, current } = useSyncHover();

  const itemIndex = useMemo(() => {
    const map = new Map<string, { block: BlockDto; start: number; end: number }>();
    for (const b of blocks ?? []) {
      if (!b.ko || !b.koSentences?.length) continue;
      for (const [page, item, start, end] of b.spans) map.set(`${page}:${item}`, { block: b, start, end });
    }
    return map;
  }, [blocks]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || !enabled) return;
    let raf = 0;
    let point: { x: number; y: number } | null = null;
    const clearPdfHover = () => clearHover('pdf');
    const resolve = () => {
      raf = 0;
      const hit = point && hitTest(point.x, point.y);
      const entry = hit && itemIndex.get(`${hit.page}:${hit.item}`);
      if (!hit || !entry) return clearPdfHover();
      const { block, start, end } = entry;
      const offset = Math.abs(hit.length - (end - start)) > 1 ? (hit.offset * (end - start)) / hit.length : hit.offset;
      const pos = start + offset;
      const list = block.koSentences;
      if (!list?.length) return clearPdfHover();
      const inside = list.findIndex((s) => s.start <= pos && pos < s.end);
      const before = list.findLastIndex((s) => s.start <= pos);
      const sentence = inside >= 0 ? inside : before;
      if (sentence < 0) return clearPdfHover();
      const cur = current();
      if (cur?.from === 'pdf' && cur.block === block.idx && cur.sentence === sentence) return;
      setHover({ block: block.idx, sentence, from: 'pdf' });
    };
    const onMove = (e: MouseEvent) => {
      point = { x: e.clientX, y: e.clientY };
      raf ||= requestAnimationFrame(resolve);
    };
    const onLeave = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      clearPdfHover();
    };
    pane.addEventListener('mousemove', onMove);
    pane.addEventListener('mouseleave', onLeave);
    return () => {
      pane.removeEventListener('mousemove', onMove);
      pane.removeEventListener('mouseleave', onLeave);
      cancelAnimationFrame(raf);
      clearPdfHover();
    };
  }, [paneRef, enabled, itemIndex, setHover, clearHover, current]);

  useEffect(() => {
    const block = hover && blocks?.find((b) => b.idx === hover.block);
    const sentence = block && hover ? block.koSentences?.[hover.sentence] : undefined;
    showSync(enabled && block?.spans.length && sentence ? rangesFor(block, sentence.start, sentence.end) : []);
  }, [hover, blocks, enabled]);

  useEffect(() => () => showSync([]), []);
  return null;
}

export function PdfPane() {
  const { paper, highlights, updateHighlight } = usePaper();
  const viewer = useViewer();
  const { utilsRef, currentPage, numPages, setCurrentPage, setNumPages, jumpToPage, showTranslation } = viewer;
  const paneRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState<PdfScaleValue>('page-width');
  const [areaMode, setAreaMode] = useState(false);
  const [pageInput, setPageInput] = useState('');
  const areaModeRef = useRef(areaMode);
  areaModeRef.current = areaMode;
  const registeredViewer = useRef<unknown>(null);
  /** The viewer and the node in its scroll container that holds the explain markers and cards. */
  const [explain, setExplain] = useState<{ viewer: PDFViewer; host: HTMLDivElement } | null>(null);
  const [cite, setCite] = useState<{ hit: CiteHit; pos: PopoverPos } | null>(null);
  const closeCite = useCallback(() => setCite(null), []);

  // Capture phase: a citation that is also a pdf.js internal link must open the popover instead of jumping.
  const onPaneClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (areaMode || !window.getSelection()?.isCollapsed) return;
    if (e.target instanceof Element && e.target.closest('.PdfHighlighter__tip-container')) return;
    const hit = citationAtClick(e);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left;
    const y = e.clientY - box.top;
    const left = Math.max(8, Math.min(x - 16, box.width - 428));
    // Lower half of the pane: open upward so the popover stays visible.
    const pos: PopoverPos = y > box.height * 0.55 ? { left, bottom: box.height - y + 12 } : { left, top: y + 14 };
    setCite({ hit, pos });
  };

  // MouseSelection only re-reads this callback after a drag, so read the toggle through a ref.
  const enableAreaSelection = useCallback((e: MouseEvent) => e.altKey || areaModeRef.current, []);

  const onUtils = useCallback(
    (utils: PdfHighlighterUtils) => {
      utilsRef.current = utils;
      const v = utils.getViewer();
      if (!v || registeredViewer.current === v) return;
      registeredViewer.current = v;
      v.eventBus.on('pagechanging', (e: { pageNumber: number }) => setCurrentPage(e.pageNumber));
      v.eventBus.on('pagesinit', () => setNumPages(v.pagesCount));
      // Inside the scroll container: scrolls with the pages, and page offsets share its origin.
      const host = document.createElement('div');
      host.className = 'pr-explain-host';
      v.container.appendChild(host);
      // utilsRef runs during PdfHighlighter's render; defer our state updates.
      setTimeout(() => {
        if (v.pagesCount) setNumPages(v.pagesCount);
        setExplain({ viewer: v, host });
      }, 0);
    },
    [utilsRef, setCurrentPage, setNumPages],
  );

  // The lib applies pdfScaleValue only on resize, so also push it to the viewer directly.
  useEffect(() => {
    const v = utilsRef.current?.getViewer();
    if (v) v.currentScaleValue = String(scale);
  }, [scale, utilsRef]);

  const updateRef = useRef(updateHighlight);
  updateRef.current = updateHighlight;
  const onAreaChange = useCallback((id: string, position: HighlightPosition, imageDataUrl: string) => {
    void updateRef.current(id, { position, imageDataUrl });
  }, []);

  const libHighlights = useMemo<Highlight[]>(() => highlights.map(toAppHighlight), [highlights]);

  const selectionTip = useMemo(() => <SelectionTip />, []);
  const container = useMemo(() => <HighlightContainer onAreaChange={onAreaChange} />, [onAreaChange]);

  const zoom = (delta: number) => {
    const v = utilsRef.current?.getViewer();
    const cur = typeof scale === 'number' ? scale : (v?.currentScale ?? 1);
    setScale(clampScale(cur + delta));
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 overflow-hidden border-b border-line bg-surface px-2 text-[12px] whitespace-nowrap [&>*]:shrink-0">
        <button className={iconBtnCls} onClick={() => zoom(-0.1)} title="축소" aria-label="축소">
          <Minus size={14} />
        </button>
        <span className="w-10 text-center font-mono tabular-nums text-fg-muted">
          {typeof scale === 'number' ? `${Math.round(scale * 100)}%` : '맞춤'}
        </span>
        <button className={iconBtnCls} onClick={() => zoom(0.1)} title="확대" aria-label="확대">
          <Plus size={14} />
        </button>
        <button className={chipCls(scale === 'page-width')} onClick={() => setScale('page-width')} aria-pressed={scale === 'page-width'}>
          폭 맞춤
        </button>
        <div className="mx-2 flex items-center gap-1">
          <input
            className="h-7 w-10 rounded-md border border-line-strong bg-sunken px-1 text-center font-mono tabular-nums text-fg outline-none transition-[border-color] duration-150 placeholder:text-fg-dim focus:border-focus"
            value={pageInput}
            placeholder={String(currentPage)}
            onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && pageInput) {
                jumpToPage(parseInt(pageInput, 10));
                setPageInput('');
              }
            }}
            aria-label="쪽 번호"
          />
          <span className="font-mono tabular-nums text-fg-muted" data-testid="page-indicator">
            {currentPage} / {numPages || paper.pageCount || '?'}
          </span>
        </div>
        <button className={chipCls(areaMode)} onClick={() => setAreaMode((m) => !m)} aria-pressed={areaMode}>
          영역 선택
        </button>
        <span className="ml-auto min-w-0 !shrink truncate text-fg-dim">{ALT_KEY} 드래그로 영역 선택</span>
      </div>
      <div ref={paneRef} className="pdf-pane relative min-h-0 flex-1" onClickCapture={onPaneClick}>
        <SyncHoverBridge paneRef={paneRef} enabled={showTranslation} />
        <PdfLoader
          document={`/api/papers/${paper.id}/pdf`}
          workerSrc={workerUrl}
          beforeLoad={() => <div className="p-6 text-[13px] text-fg-muted">PDF 불러오는 중…</div>}
          errorMessage={(e) => <div className="p-6 text-[13px] text-danger">PDF를 열지 못했습니다: {e.message}</div>}
          onError={(e) => console.error(e)}
        >
          {(pdfDocument) => (
            <PdfHighlighter
              pdfDocument={pdfDocument}
              highlights={libHighlights}
              enableAreaSelection={enableAreaSelection}
              selectionTip={selectionTip}
              pdfScaleValue={scale}
              utilsRef={onUtils}
              textSelectionColor="rgba(35,178,255,0.3)"
            >
              {container}
            </PdfHighlighter>
          )}
        </PdfLoader>
        {cite && <CitationPopover paperId={paper.id} hit={cite.hit} pos={cite.pos} onClose={closeCite} />}
        {explain && <ExplainLayer viewer={explain.viewer} host={explain.host} />}
      </div>
    </div>
  );
}
