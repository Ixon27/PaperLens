import { useMemo, useState } from 'react';
import { preparePoints, readAt, type CurveScale, type Point, type Reading } from './interpolation';
import { formatNumber } from './scales';

type Curve = { name: string; points: readonly Point[] };
type Readout = {
  x: number; setChosen: (x: number) => void; min: number; max: number; hasPoints: boolean;
  readings: { name: string; reading: Reading | null }[];
  dots: { x: number; y: number; name: string }[];
};

export function useCurveReadout(curves: readonly Curve[], active: Set<string>, scale: CurveScale = {}): Readout {
  const prepared = useMemo(() => curves.map(curve => ({ name: curve.name, points: preparePoints(curve.points) })), [curves]);
  let min = Infinity, max = -Infinity;
  for (const curve of prepared) for (const point of curve.points) {
    min = Math.min(min, point.x); max = Math.max(max, point.x);
  }
  const hasPoints = min !== Infinity;
  if (!hasPoints) { min = 0; max = 0; }
  const [chosen, setChosen] = useState(() => min);
  const x = Math.max(min, Math.min(max, chosen));
  const readings = prepared.filter(curve => active.has(curve.name)).map(curve => ({ name: curve.name, reading: readAt(curve.points, x, scale) }));
  const dots = readings.flatMap(({ name, reading }) => reading ? (reading.kind === 'exact' ? reading.values : [reading.value]).map(y => ({ x, y, name })) : []);
  return { x, setChosen, min, max, hasPoints, readings, dots };
}

export function CurveReadout({ state, xLabel, yLabel }: { state: Readout; xLabel: string; yLabel: string }) {
  const { x, setChosen, min, max, hasPoints, readings } = state;
  const span = max - min;
  return <div className="space-y-1 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-fg">
    <label className="flex flex-wrap items-center gap-2">
      <span>{xLabel}</span>
      <input aria-label={`${xLabel} 탐색`} className="min-w-24 flex-1" type="range" min={0} max={1000} step={1} disabled={!hasPoints || !(span > 0)} value={span > 0 ? Math.max(0, Math.min(1000, (x - min) / span * 1000)) : 0} onChange={event => setChosen(min + span * Number(event.target.value) / 1000)} />
      <input aria-label={`${xLabel} 값`} className="w-24 rounded border border-line bg-surface px-1 py-0.5 text-fg" type="number" step="any" min={min} max={max} disabled={!hasPoints} value={x} onChange={event => { if (event.target.value !== '' && Number.isFinite(event.target.valueAsNumber)) setChosen(event.target.valueAsNumber); }} />
    </label>
    <div className="flex flex-wrap gap-x-4 gap-y-1" aria-live="polite" aria-atomic="true">
      {readings.length ? readings.map(({ name, reading }) => <span key={name}><strong>{name}</strong> · {yLabel}: {reading ? reading.kind === 'exact' ? reading.values.map(String).join(', ') + ' (데이터 지점)' : `≈ ${formatNumber(reading.value)} (보간)` : '값 없음'}</span>) : <span className="text-fg-muted">표시할 시리즈를 선택하세요.</span>}
    </div>
  </div>;
}
