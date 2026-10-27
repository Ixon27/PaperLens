import { useEffect, useRef } from 'react';
import { reducedMotion } from './motion';

const WAVE = 'M0 14 Q 75 0 150 14 T 300 14 T 450 14 T 600 14 T 750 14 T 900 14 T 1050 14 T 1200 14 V28 H0 Z';

/**
 * File-drop feedback: liquid rises while a file hovers (`active`) and ripples spread from the drop point.
 * Fills its positioned parent; `dropAt` is in the parent's coordinates and a new `key` fires one set of ripples.
 */
export function LiquidDrop({ active, dropAt }: { active: boolean; dropAt: { x: number; y: number; key: number } | null }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = ref.current;
    if (!dropAt || !host || reducedMotion()) return;
    for (let i = 0; i < 3; i++) {
      const el = document.createElement('div');
      el.className = 'pr-ripple absolute h-6 w-6 rounded-full border-2 border-accent';
      el.style.left = `${dropAt.x}px`;
      el.style.top = `${dropAt.y}px`;
      host.append(el);
      const anim = el.animate(
        [
          { transform: 'translate(-50%,-50%) scale(0.4)', opacity: 0.6 },
          { transform: 'translate(-50%,-50%) scale(9)', opacity: 0 },
        ],
        // `both`: the delayed rings stay hidden at the first frame instead of flashing in place.
        { duration: 750, delay: i * 110, easing: 'cubic-bezier(0.23,1,0.32,1)', fill: 'both' },
      );
      void anim.finished.then(() => el.remove(), () => el.remove());
    }
    // Only a new drop (key) fires ripples.
  }, [dropAt?.key]);

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <div className="pr-liquid" data-active={active || undefined}>
        <div className="pr-liquid-bob">
          <svg className="pr-wave pr-wave--back" viewBox="0 0 1200 28" preserveAspectRatio="none">
            <path d={WAVE} fill="var(--pr-accent)" fillOpacity={0.1} />
          </svg>
          <svg className="pr-wave" viewBox="0 0 1200 28" preserveAspectRatio="none">
            <path d={WAVE} fill="var(--pr-accent)" fillOpacity={0.18} />
          </svg>
          <div className="flex-1" style={{ background: 'color-mix(in srgb, var(--pr-accent) 18%, transparent)' }} />
        </div>
      </div>
    </div>
  );
}
