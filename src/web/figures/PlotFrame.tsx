import { useEffect, useRef, useState } from 'react';
import * as Plot from '@observablehq/plot';

// Only explicit string domains are laid out here. Continuous axes and inferred
// scales retain Plot's own sizing and tick generation.
function categoryLabels(scale: Plot.PlotOptions['x']): string[] {
  if (!scale?.domain || scale.axis === null || scale.axis === false) return [];
  const values = Array.from(scale.domain);
  return values.every(value => typeof value === 'string') ? values : [];
}

function categoryLayout(options: Plot.PlotOptions, availableWidth: number, measure: (s: string) => number) {
  const fx = categoryLabels(options.fx);
  const x = fx.length ? fx : categoryLabels(options.x);
  const y = categoryLabels(options.y);
  if (!x.length && !y.length) return { ...options, width: availableWidth };

  const xScale = fx.length ? options.fx! : options.x!;
  const longestX = Math.max(0, ...x.map(measure));
  const longestY = Math.max(0, ...y.map(measure));
  const left = Math.max(options.marginLeft ?? options.margin ?? 40, y.length ? longestY + 24 : 40);
  const right = Math.max(options.marginRight ?? options.margin ?? 20, 20);
  const needsRotation = x.length > 0 && longestX + 12 > Math.max(0, availableWidth - left - right) / x.length;
  const rotate = xScale?.tickRotate ?? (needsRotation ? -90 : 0);
  const angle = Math.abs(rotate * Math.PI / 180);
  const horizontal = Math.abs(Math.cos(angle)) * longestX + Math.abs(Math.sin(angle)) * 14;
  const vertical = Math.abs(Math.sin(angle)) * longestX + Math.abs(Math.cos(angle)) * 14;
  const topAxis = xScale?.axis === 'top';
  const labelSpace = x.length ? Math.ceil(vertical + (xScale?.label ? 35 : 18)) : 0;
  const top = Math.max(options.marginTop ?? options.margin ?? 20, topAxis ? labelSpace : 20);
  const bottom = Math.max(options.marginBottom ?? options.margin ?? 30, !topAxis ? labelSpace : 30);
  // A full slot for each label also prevents collisions when callers explicitly
  // request unrotated ticks. Keep an edge allowance for the first and last tick.
  const width = Math.max(availableWidth, Math.ceil(left + right + x.length * (horizontal + 8)));
  const extraMargins = Math.max(0, top - 20) + Math.max(0, bottom - 30);
  const height = Math.max((options.height ?? 400) + extraMargins, y.length ? top + bottom + y.length * 22 : 0);
  const axis = x.length && xScale?.tickRotate === undefined ? { ...xScale, tickRotate: rotate } : xScale;
  return {
    ...options, width, height, marginLeft: left, marginRight: right, marginTop: top, marginBottom: bottom,
    ...(fx.length ? { fx: axis } : x.length ? { x: axis } : {}),
  };
}

export function PlotFrame({ options }: { options: Plot.PlotOptions }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => setWidth(Math.floor(entries[0].contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || width <= 0) return;
    const color: Plot.PlotOptions['color'] = options.color?.range || options.color?.scheme || options.color?.type
      ? options.color
      : { scheme: 'tableau10', ...options.color };
    const context = document.createElement('canvas').getContext('2d');
    if (context) context.font = '12px system-ui, sans-serif';
    const layout = categoryLayout(options, width, text => context?.measureText(text).width ?? text.length * 12);
    const style = typeof options.style === 'string' ? options.style : { background: 'transparent', color: 'currentColor', fontSize: '12px', ...options.style };
    const chart = Plot.plot({ ...layout, color, style });
    // Plot defaults to max-width: 100%; give it a wide containing block so
    // that the SVG scrolls rather than shrinking its labels back together.
    const canvas = document.createElement('div');
    canvas.style.width = `${layout.width}px`;
    canvas.append(chart);
    el.replaceChildren(canvas);
    setScrollable(layout.width > width);
    return () => { canvas.remove(); };
  }, [options, width]);
  return <div>
    {scrollable && <p className="mb-1 text-xs text-fg-muted">가로로 스크롤해 전체 항목 보기</p>}
    <div ref={ref} className="w-full overflow-x-auto" tabIndex={scrollable ? 0 : undefined} role={scrollable ? 'region' : undefined} aria-label={scrollable ? '그래프 (가로로 스크롤 가능)' : undefined} />
  </div>;
}
