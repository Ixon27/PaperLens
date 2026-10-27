import {
  AreaHighlight,
  MonitoredHighlightContainer,
  TextHighlight,
  useHighlightContainerContext,
  usePdfHighlighterContext,
  type Highlight,
  type ViewportHighlight,
} from 'react-pdf-highlighter-extended';
import { HIGHLIGHT_COLORS, type HighlightColor, type HighlightPosition } from '../types';

export interface AppHighlight extends Highlight {
  color?: HighlightColor;
  note?: string | null;
  text?: string | null;
}

const BLOCK_STYLE = { background: 'rgba(35,178,255,0.22)', outline: '1px solid rgba(35,178,255,0.65)' };
const GHOST_COLOR = 'rgba(253,224,71,0.6)';

function hexToRgba(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function NoteTip({ note }: { note: string }) {
  return <div className="max-w-[320px] whitespace-pre-wrap rounded-lg border border-line bg-raised px-3 py-2 text-[12.5px] text-fg shadow-pop">{note}</div>;
}

/**
 * Renders one highlight inside the lib's per-page React roots — app contexts are NOT available
 * here, so everything comes from the lib's contexts or props.
 */
export function HighlightContainer({ onAreaChange }: { onAreaChange(id: string, position: HighlightPosition, imageDataUrl: string): void }) {
  const { highlight, viewportToScaled, screenshot, isScrolledTo } = useHighlightContainerContext<AppHighlight>();
  const { toggleEditInProgress } = usePdfHighlighterContext();
  const h = highlight as ViewportHighlight<AppHighlight>;

  if (h.id.startsWith('__')) {
    return <TextHighlight highlight={h} isScrolledTo={false} style={BLOCK_STYLE} />;
  }

  const saved = Boolean(h.color);
  const fill = h.color ? hexToRgba(HIGHLIGHT_COLORS[h.color], 0.45) : GHOST_COLOR;

  const component =
    h.type === 'area' ? (
      <AreaHighlight
        highlight={h}
        isScrolledTo={isScrolledTo}
        style={{ background: fill, outline: isScrolledTo ? '2px solid #23b2ff' : undefined }}
        onEditStart={() => toggleEditInProgress(true)}
        onChange={(rect) => {
          toggleEditInProgress(false);
          if (!saved) return;
          const scaled = viewportToScaled(rect);
          onAreaChange(h.id, { boundingRect: scaled, rects: [] }, screenshot(rect));
        }}
      />
    ) : (
      <TextHighlight highlight={h} isScrolledTo={isScrolledTo} style={{ background: fill, outline: isScrolledTo ? '1px solid #23b2ff' : undefined }} />
    );

  if (!h.note) return component;
  return (
    <MonitoredHighlightContainer highlightTip={{ position: h.position, content: <NoteTip note={h.note} /> }}>{component}</MonitoredHighlightContainer>
  );
}
