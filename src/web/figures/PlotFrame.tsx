import { useEffect, useRef, useState } from 'react';
import * as Plot from '@observablehq/plot';

export function PlotFrame({ options }: { options: Plot.PlotOptions }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
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
    const chart = Plot.plot({ ...options, width, color, style: { background: 'transparent', color: 'currentColor', fontSize: '12px' } });
    el.replaceChildren(chart);
    return () => { chart.remove(); };
  }, [options, width]);
  return <div ref={ref} className="w-full overflow-x-auto" />;
}
