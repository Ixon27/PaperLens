export type Point = { x: number; y: number };
export type Reading = { kind: 'exact'; values: number[] } | { kind: 'approximate'; value: number };
export type CurveScale = { logX?: boolean; logY?: boolean };

/** Sort once per curve; retain distinct measurements at the same x. */
export function preparePoints(points: readonly Point[]): Point[] {
  return points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)).slice().sort((a, b) => a.x - b.x);
}

/** Interpolate along the displayed axis scales, without extrapolating or crossing ambiguous points. */
export function readAt(points: readonly Point[], x: number, scale: CurveScale = {}): Reading | null {
  if (!Number.isFinite(x) || !points.length) return null;
  let lo = 0, hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].x < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo < points.length && points[lo].x === x) {
    const values: number[] = [];
    for (let i = lo; i < points.length && points[i].x === x; i++) {
      if (!values.includes(points[i].y)) values.push(points[i].y);
    }
    return { kind: 'exact', values };
  }
  if (lo === 0 || lo === points.length) return null;
  const left = points[lo - 1], right = points[lo];
  for (let i = lo - 2; i >= 0 && points[i].x === left.x; i--) if (points[i].y !== left.y) return null;
  for (let i = lo + 1; i < points.length && points[i].x === right.x; i++) if (points[i].y !== right.y) return null;
  if ((scale.logX && (left.x <= 0 || x <= 0 || right.x <= 0)) || (scale.logY && (left.y <= 0 || right.y <= 0))) return null;
  const x0 = scale.logX ? Math.log(left.x) : left.x;
  const x1 = scale.logX ? Math.log(right.x) : right.x;
  const at = scale.logX ? Math.log(x) : x;
  const y0 = scale.logY ? Math.log(left.y) : left.y;
  const y1 = scale.logY ? Math.log(right.y) : right.y;
  const projected = y0 + (y1 - y0) * ((at - x0) / (x1 - x0));
  const value = scale.logY ? Math.exp(projected) : projected;
  return Number.isFinite(value) ? { kind: 'approximate', value } : null;
}
