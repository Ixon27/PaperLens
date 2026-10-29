import { Sparkles } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PDFViewer } from 'pdfjs-dist/types/web/pdf_viewer';
import { api } from '../api';
import { useToast } from '../components/Toast';
import { usePaper } from '../state/paper';
import type { BlockDto, ExplanationDto, ThreadDto } from '../types';
import { anchorId, anchorOf, type ExplainAnchor } from '../../shared/explain';
import { CARD_MIN, ExplainCard, type CardSize } from './ExplainCard';

interface PageView {
  div: HTMLDivElement;
  canvas?: HTMLCanvasElement | null;
}

const pageView = (viewer: PDFViewer, page: number) => viewer.getPageView(page - 1) as PageView | undefined;

const SIZE_KEY = 'pr.explainCard.size';
const DEFAULT_SIZE: CardSize = { w: 420, h: 460 };
const LAYOUT_EVENTS = ['pagesinit', 'scalechanging', 'rotationchanging'];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function readSize(): CardSize {
  try {
    const v = JSON.parse(localStorage.getItem(SIZE_KEY) ?? 'null') as Partial<CardSize> | null;
    if (v && Number.isFinite(v.w) && Number.isFinite(v.h)) return { w: Math.max(CARD_MIN.w, v.w!), h: Math.max(CARD_MIN.h, v.h!) };
  } catch {
    // fall back to the default size
  }
  return DEFAULT_SIZE;
}

/** The drawn page as a PNG data URL (at most 1600 px on its long side), or null before it is drawn. */
function capturePage(viewer: PDFViewer, page: number): string | null {
  const canvas = pageView(viewer, page)?.canvas;
  if (!canvas || !canvas.width) return null;
  const r = Math.min(1, 1600 / Math.max(canvas.width, canvas.height));
  const out = document.createElement('canvas');
  out.width = Math.round(canvas.width * r);
  out.height = Math.round(canvas.height * r);
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

interface Marker {
  id: string;
  anchor: ExplainAnchor;
  block: BlockDto;
}

/** A marker's spot in the PDF scroll content, and its page's horizontal extent. */
interface Spot {
  left: number;
  top: number;
  pageLeft: number;
  pageWidth: number;
}

const MARKER_LABEL: Record<ExplainAnchor['type'], string> = { section: '이 섹션 설명', figure: '이 그림 설명', table: '이 표 설명' };

/**
 * Explain markers beside section headings and figure/table captions, and their cards. Rendered into
 * `host`, a node inside the viewer's scroll container, so everything scrolls with the pages.
 */
export function ExplainLayer({ viewer, host }: { viewer: PDFViewer; host: HTMLElement }) {
  const { paper, blocks } = usePaper();
  const toast = useToast();
  /** By anchorId. */
  const [explanations, setExplanations] = useState<Map<string, ExplanationDto>>(() => new Map());
  const [openId, setOpenId] = useState<string | null>(null);
  /** Cards opened this session; minimized ones stay mounted (hidden) so an answer keeps streaming. */
  const [mounted, setMounted] = useState<string[]>([]);
  const [creating, setCreating] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [size, setSize] = useState(readSize);
  const [tick, setTick] = useState(0);
  /** Page images for cards created this session whose explanation is still to be written (null: no image). */
  const autoStart = useRef(new Map<string, string | null>());

  const markers = useMemo(() => {
    const out: Marker[] = [];
    for (let i = 0; i < (blocks?.length ?? 0); i++) {
      const a = anchorOf(blocks!, i);
      if (a) out.push({ id: anchorId(a), anchor: a, block: blocks![i] });
    }
    return out;
  }, [blocks]);

  useEffect(() => {
    let alive = true;
    api<ExplanationDto[]>(`/api/papers/${paper.id}/explanations`)
      .then((list) => alive && setExplanations(new Map(list.map((e) => [anchorId(e.anchor), e]))))
      .catch((e: unknown) => alive && toast((e as Error).message, { tone: 'error' }));
    return () => {
      alive = false;
    };
  }, [paper.id, toast]);

  // Page boxes move when pages appear, on zoom or rotation, and when the pane resizes.
  useEffect(() => {
    let raf = 0;
    const bump = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setTick((t) => t + 1));
    };
    for (const name of LAYOUT_EVENTS) viewer.eventBus.on(name, bump);
    const ro = new ResizeObserver(bump);
    if (viewer.viewer) ro.observe(viewer.viewer);
    ro.observe(viewer.container);
    bump();
    return () => {
      for (const name of LAYOUT_EVENTS) viewer.eventBus.off(name, bump);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [viewer]);

  const spots = useMemo(() => {
    const out = new Map<string, Spot>();
    for (const m of markers) {
      const d = pageView(viewer, m.anchor.page)?.div;
      if (!d?.clientWidth) continue;
      const sx = d.clientWidth / m.block.pageW;
      const sy = d.clientHeight / m.block.pageH;
      const [x1, y1, x2, y2] = m.block.lines[0];
      let left: number;
      let top: number;
      if (m.anchor.type === 'section') {
        left = d.offsetLeft + x2 * sx + 6;
        top = d.offsetTop + ((y1 + y2) / 2) * sy - 12;
        if (left > d.offsetLeft + d.clientWidth - 28) left = d.offsetLeft + x1 * sx - 30;
      } else {
        // Left margin, just above the caption: a figure sits above its caption and a table below.
        left = Math.max(d.offsetLeft + 2, d.offsetLeft + x1 * sx - 30);
        top = d.offsetTop + y1 * sy - 26;
      }
      out.set(m.id, { left, top, pageLeft: d.offsetLeft, pageWidth: d.clientWidth });
    }
    return out;
    // `tick` stands for the page layout read here.
  }, [markers, viewer, tick]);

  const byId = useMemo(() => new Map([...explanations.values()].map((e) => [e.id, e])), [explanations]);

  const show = useCallback((id: string) => {
    setOpenId(id);
    setMounted((list) => (list.includes(id) ? list : [...list, id]));
  }, []);

  const minimize = useCallback(() => setOpenId(null), []);

  const open = async (m: Marker) => {
    const existing = explanations.get(m.id);
    if (existing) {
      if (openId === existing.id) minimize();
      else show(existing.id);
      return;
    }
    if (creating.has(m.id)) return;
    const image = m.anchor.type === 'section' ? null : capturePage(viewer, m.anchor.page);
    setCreating((s) => new Set(s).add(m.id));
    try {
      const e = await api<ExplanationDto>(`/api/papers/${paper.id}/explanations`, { method: 'POST', json: { anchor: m.anchor } });
      if (!e.answered) autoStart.current.set(e.id, image);
      setExplanations((map) => new Map(map).set(anchorId(e.anchor), e));
      show(e.id);
    } catch (err) {
      toast((err as Error).message, { tone: 'error' });
    } finally {
      setCreating((s) => {
        const next = new Set(s);
        next.delete(m.id);
        return next;
      });
    }
  };

  const onThread = useCallback((t: ThreadDto, answered: boolean) => {
    if (answered) autoStart.current.delete(t.id);
    setExplanations((map) => {
      for (const [key, e] of map) {
        if (e.id === t.id) return new Map(map).set(key, { ...e, ...t, answered: e.answered || answered });
      }
      return map;
    });
  }, []);

  const onDeleted = useCallback((id: string) => {
    autoStart.current.delete(id);
    setExplanations((map) => new Map([...map].filter(([, e]) => e.id !== id)));
    setMounted((list) => list.filter((x) => x !== id));
    setOpenId((cur) => (cur === id ? null : cur));
    setBusy((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }, []);

  const setCardBusy = useCallback((id: string, on: boolean) => {
    setBusy((s) => {
      if (s.has(id) === on) return s;
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const onResize = useCallback((next: CardSize) => {
    setSize(next);
    localStorage.setItem(SIZE_KEY, JSON.stringify(next));
  }, []);

  const cardBox = (e: ExplanationDto) => {
    const spot = spots.get(anchorId(e.anchor));
    if (!spot) return null;
    // Never wider than the page or the pane, so the header buttons stay reachable in a narrow pane.
    const maxWidth = Math.max(0, Math.min(spot.pageWidth, viewer.container.clientWidth) - 16);
    const w = Math.min(size.w, maxWidth);
    return { left: clamp(spot.left - 12, spot.pageLeft + 8, spot.pageLeft + spot.pageWidth - w - 8), top: spot.top + 32, maxWidth };
  };

  // Bring a card that just opened into view inside the PDF (not by scrolling the window's panes).
  const openExplanation = openId ? byId.get(openId) : undefined;
  const openTop = openExplanation ? cardBox(openExplanation)?.top : undefined;
  useLayoutEffect(() => {
    if (openTop === undefined) return;
    const c = viewer.container;
    const top = openTop - 8;
    const bottom = openTop + size.h + 8;
    if (bottom > c.scrollTop + c.clientHeight) c.scrollTop = Math.min(top, bottom - c.clientHeight);
    else if (top < c.scrollTop) c.scrollTop = top;
    // Only when a card opens, not while it streams or the layout shifts.
  }, [openId]);

  return createPortal(
    <>
      {markers.map((m) => {
        const spot = spots.get(m.id);
        if (!spot) return null;
        const e = explanations.get(m.id);
        const spinning = creating.has(m.id) || (e !== undefined && busy.has(e.id));
        const label = e?.answered ? '설명 열기' : MARKER_LABEL[m.anchor.type];
        return (
          <button
            key={m.id}
            className={`absolute grid h-6 w-6 place-items-center rounded-md border shadow-sm transition-colors duration-150 ${
              e?.answered ? 'border-accent/60 bg-accent-soft text-accent' : 'border-line bg-surface/90 text-fg-muted hover:text-fg'
            }`}
            style={{ left: spot.left, top: spot.top }}
            aria-label={label}
            aria-expanded={e !== undefined && openId === e.id}
            title={label}
            onClick={() => void open(m)}
          >
            {spinning ? (
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <Sparkles size={13} />
            )}
          </button>
        );
      })}
      {mounted.map((id) => {
        const e = byId.get(id);
        const box = e && cardBox(e);
        if (!e || !box) return null;
        return (
          <ExplainCard
            key={id}
            explanation={e}
            hidden={openId !== id}
            style={{ left: box.left, top: box.top }}
            size={size}
            maxWidth={box.maxWidth}
            viewport={viewer.container}
            onResize={onResize}
            onMinimize={minimize}
            onDeleted={onDeleted}
            onThread={onThread}
            onBusyChange={(on) => setCardBusy(id, on)}
            autoStartImage={autoStart.current.get(id)}
            captureImage={() => (e.anchor.type === 'section' ? null : capturePage(viewer, e.anchor.page))}
          />
        );
      })}
    </>,
    host,
  );
}
