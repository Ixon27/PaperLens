import { useEffect, useState } from 'react';
import type { FigureSpec } from '../../shared/figure-spec';
import { PageChip } from '../components/Markdown';
import { useViewer } from '../state/viewer';
import { useCloseFigure } from './FigureDisplayContext';

type Hotspot = Extract<FigureSpec, { kind: 'hotspot' }>;

export function HotspotWidget({ spec, imageUrl }: { spec: Hotspot; imageUrl: string | null }) {
  const { jumpToPage } = useViewer();
  const closeFigure = useCloseFigure();
  const jump = (page: number) => { closeFigure(); jumpToPage(page); };
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    setDimensions(null);
    if (!imageUrl) return;
    const image = new Image();
    image.onload = () => setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
    image.src = imageUrl;
    return () => { image.onload = null; };
  }, [imageUrl]);
  const [x0, y0, x1, y1] = spec.box;
  const bw = x1 - x0, bh = y1 - y0;
  const spot = selected === null ? null : spec.spots[selected];
  return (
    <div className="space-y-2 text-[12.5px]">
      <div className="inline-flex rounded-full bg-warning-soft px-2 py-1 text-warning">실험적 · 위치가 어긋날 수 있음</div>
      {imageUrl && dimensions && (
        <div className="relative w-full overflow-hidden rounded-lg border border-line bg-sunken" style={{
          aspectRatio: `${bw * dimensions.width} / ${bh * dimensions.height}`,
          backgroundImage: `url(${JSON.stringify(imageUrl)})`,
          backgroundSize: `${100 / bw}% auto`,
          backgroundPosition: `${bw === 1 ? 0 : 100 * x0 / (1 - bw)}% ${bh === 1 ? 0 : 100 * y0 / (1 - bh)}%`,
          backgroundRepeat: 'no-repeat',
        }}>
          {spec.spots.map((item, i) => (
            <button key={i} type="button" aria-label={`${i + 1}. ${item.label}`} aria-pressed={selected === i}
              className="absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-accent text-[12px] font-bold text-accent-fg shadow-pop focus-visible:ring-2 focus-visible:ring-focus"
              style={{ left: `${item.x * 100}%`, top: `${item.y * 100}%` }} onClick={() => setSelected(i)}>{i + 1}</button>
          ))}
        </div>
      )}
      {spot && <div className="rounded-lg border border-accent/30 bg-accent-soft p-2"><strong>{selected! + 1}. {spot.label}</strong><p className="mt-1">{spot.detail}</p>{spot.page && <PageChip page={spot.page} onJump={jump} />}</div>}
      <ol className="space-y-1">{spec.spots.map((item, i) => <li key={i}><button type="button" className="text-left text-accent hover:underline" onClick={() => setSelected(i)}>{i + 1}. {item.label}</button> <span className="text-fg-muted">{item.detail}</span>{item.page && <PageChip page={item.page} onJump={jump} />}</li>)}</ol>
    </div>
  );
}
