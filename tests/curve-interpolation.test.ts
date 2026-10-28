import { describe, expect, it } from 'vitest';
import { preparePoints, readAt } from '../src/web/figures/interpolation';

describe('curve readings', () => {
  it('sorts without mutating and distinguishes measurements from estimates', () => {
    const input = [{ x: 4, y: 10 }, { x: 0, y: 2 }, { x: 2, y: 4 }];
    const points = preparePoints(input);
    expect(input[0].x).toBe(4);
    expect(readAt(points, 2)).toEqual({ kind: 'exact', values: [4] });
    expect(readAt(points, 3)).toEqual({ kind: 'approximate', value: 7 });
  });

  it('does not extrapolate, including disjoint curves and single points', () => {
    const a = preparePoints([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    const b = preparePoints([{ x: 3, y: 5 }, { x: 4, y: 6 }]);
    expect(readAt(a, 2)).toBeNull();
    expect(readAt(b, 2)).toBeNull();
    expect(readAt([], 0)).toBeNull();
    expect(readAt(preparePoints([{ x: 2, y: 8 }]), 2)).toEqual({ kind: 'exact', values: [8] });
    expect(readAt(preparePoints([{ x: 2, y: 8 }]), 3)).toBeNull();
  });

  it('preserves conflicting duplicate measurements and avoids ambiguous interpolation', () => {
    const points = preparePoints([{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 1, y: 3 }, { x: 2, y: 4 }]);
    expect(readAt(points, 1)).toEqual({ kind: 'exact', values: [2, 3] });
    expect(readAt(points, 0.5)).toBeNull();
    expect(readAt(points, 1.5)).toBeNull();
    const repeated = preparePoints([{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 1, y: 2 }]);
    expect(readAt(repeated, 0.5)).toEqual({ kind: 'approximate', value: 1 });
    expect(readAt(repeated, 1)).toEqual({ kind: 'exact', values: [2] });
  });

  it('matches the displayed line when either axis is logarithmic', () => {
    const points = preparePoints([{ x: 1, y: 1 }, { x: 100, y: 100 }]);
    const xLog = readAt(points, 10, { logX: true });
    const yLog = readAt(points, 50.5, { logY: true });
    const both = readAt(points, 10, { logX: true, logY: true });
    expect(xLog?.kind).toBe('approximate');
    expect(xLog && 'value' in xLog && xLog.value).toBeCloseTo(50.5);
    expect(yLog && 'value' in yLog && yLog.value).toBeCloseTo(10);
    expect(both && 'value' in both && both.value).toBeCloseTo(10);
    expect(readAt(preparePoints([{ x: -1, y: 1 }, { x: 1, y: 2 }]), 0.5, { logX: true })).toBeNull();
    expect(readAt(preparePoints([{ x: 0, y: -1 }, { x: 1, y: 2 }]), 0.5, { logY: true })).toBeNull();
  });

  it('ignores non-finite points and rejects non-finite coordinates', () => {
    const points = preparePoints([{ x: NaN, y: 1 }, { x: 1, y: Infinity }, { x: 2, y: 3 }]);
    expect(points).toEqual([{ x: 2, y: 3 }]);
    expect(readAt(points, NaN)).toBeNull();
  });
});
