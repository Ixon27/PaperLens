import { describe, expect, it } from 'vitest';
import { validateFigureSpec } from '../src/shared/figure-spec.js';

const base = { title: ' 제목 ', takeaway: '결과', howTo: '조작', approx: false, sources: [], notes: [] };

describe('validateFigureSpec', () => {
  it('accepts bar, formula, flow and hotspot specifications', () => {
    const examples = [
      { kind: 'bar', yLabel: 'Y', categories: ['A', 'B'], series: [{ name: 'S', values: [1, null] }] },
      { kind: 'formula', expression: 'a*x', latex: 'ax', x: { name: 'x', label: 'X', min: 0, max: 10 }, yLabel: 'Y', variables: [{ name: 'a', label: 'A', min: 0, max: 2, step: 0.1, value: 1 }] },
      { kind: 'flow', steps: [{ id: 'a', label: 'A', detail: 'A' }, { id: 'b', label: 'B', detail: 'B' }], edges: [{ from: 'a', to: 'b' }] },
      { kind: 'hotspot', box: [0, 0, 1, 1], spots: [{ x: 0.5, y: 0.5, label: 'A', detail: 'B' }] },
    ];
    for (const example of examples) expect(validateFigureSpec({ ...base, ...example }, 3)).toHaveProperty('spec');
  });
  it('restores JSON-decoded LaTeX control escapes before trimming', () => {
    const result = validateFigureSpec({ ...base, kind: 'formula', expression: 'x', latex: '\frac{A}{B}', x: { name: 'x', label: 'X', min: 0, max: 1 }, yLabel: 'Y', variables: [] }, 3);
    expect(result).toHaveProperty('spec');
    if ('spec' in result && result.spec.kind === 'formula') expect(result.spec.latex).toBe('\\frac{A}{B}');
  });
  it('rejects mismatched arrays and undeclared formula variables', () => {
    expect(validateFigureSpec({ ...base, kind: 'bar', yLabel: 'Y', categories: ['A', 'B'], series: [{ name: 'S', values: [1] }] }, 3)).toHaveProperty('error');
    expect(validateFigureSpec({ ...base, kind: 'formula', expression: 'x+y', latex: 'x+y', x: { name: 'x', label: 'X', min: 0, max: 1 }, yLabel: 'Y', variables: [] }, 3)).toHaveProperty('error');
  });
  it('accepts new chart kinds and optional formula and survival fields', () => {
    const examples = [
      { kind: 'histogram', xLabel: 'X', yLabel: 'Y', series: [{ name: 'A', bins: [{ x0: 0, x1: 1, count: 0 }, { x0: 1, x1: 2, count: 2 }] }] },
      { kind: 'field', xLabel: 'X', yLabel: 'Y', valueLabel: 'V', x: [0, 1], y: [2, 3], values: [[1, null], [2, 3]], diverging: false },
      { kind: 'roc', mode: 'pr', curves: [{ name: 'A', points: [{ x: 0, y: 1 }, { x: 1, y: 0 }], auc: 0.5 }] },
      { kind: 'stacked', yLabel: 'Y', samples: ['A'], parts: [{ name: 'P', values: [-1] }] },
      { kind: 'survival', timeLabel: 'T', yLabel: '신뢰도', groups: [{ name: 'A', steps: [{ t: 0, s: 1 }] }] },
      { kind: 'formula', expression: 'x', latex: 'x', x: { name: 'x', label: 'X', min: 1, max: 10 }, yLabel: 'Y', variables: [], xLog: true, yLog: true, yMin: 1, yMax: 20, compare: [{ name: 'double', expression: '2*x' }] },
    ];
    for (const example of examples) expect(validateFigureSpec({ ...base, ...example }, 3)).toHaveProperty('spec');
  });
  it('rejects invalid new chart boundaries', () => {
    const histogram = { ...base, kind: 'histogram', xLabel: 'X', yLabel: 'Y', series: [{ name: 'A', bins: [{ x0: 0, x1: 1, count: 1 }] }] };
    const field = { ...base, kind: 'field', xLabel: 'X', yLabel: 'Y', valueLabel: 'V', x: [0, 1], y: [0, 1], values: [[1, 2], [3, 4]], diverging: false };
    const roc = { ...base, kind: 'roc', mode: 'roc', curves: [{ name: 'A', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] };
    const bins = (items: { x0: number; x1: number; count: number }[]) => ({ ...histogram, series: [{ name: 'A', bins: items }] });
    expect(validateFigureSpec(bins([{ x0: 1, x1: 1, count: 0 }]), 3)).toHaveProperty('error', expect.stringContaining('구간 시작은 끝보다 작아야 합니다'));
    expect(validateFigureSpec(bins([{ x0: 0, x1: 1, count: -1 }]), 3)).toHaveProperty('error');
    expect(validateFigureSpec(bins([{ x0: 1, x1: 2, count: 1 }, { x0: 0, x1: 1, count: 1 }]), 3)).toHaveProperty('error');
    expect(validateFigureSpec({ ...field, x: [1, 1] }, 3)).toHaveProperty('error', expect.stringContaining('좌표는 증가해야 합니다'));
    expect(validateFigureSpec({ ...field, values: [[1], [2]] }, 3)).toHaveProperty('error');
    expect(validateFigureSpec({ ...field, x: Array.from({ length: 101 }, (_, i) => i), y: Array.from({ length: 100 }, (_, i) => i) }, 3)).toHaveProperty('error', expect.stringContaining('격자 칸은 10000개 이하여야 합니다'));
    expect(validateFigureSpec({ ...roc, curves: [{ name: 'A', points: [{ x: 0, y: 0 }, { x: 1, y: 1.2 }] }] }, 3)).toHaveProperty('error', expect.stringContaining('0~1 범위여야 합니다'));
    expect(validateFigureSpec({ ...roc, curves: [{ ...roc.curves[0], auc: -0.1 }] }, 3)).toHaveProperty('error');
  });
  it('checks formula log axes, bounds and comparison expressions', () => {
    const formula = { ...base, kind: 'formula', expression: 'x', latex: 'x', x: { name: 'x', label: 'X', min: 0, max: 1 }, yLabel: 'Y', variables: [] };
    expect(validateFigureSpec({ ...formula, xLog: true }, 3)).toHaveProperty('error', expect.stringContaining('로그 x축은 x.min이 0보다 커야 합니다'));
    expect(validateFigureSpec({ ...formula, yMin: 0 }, 3)).toHaveProperty('error', expect.stringContaining('yMin과 yMax는 함께 쓰고 yMin < yMax여야 합니다'));
    expect(validateFigureSpec({ ...formula, yMin: 1, yMax: 1 }, 3)).toHaveProperty('error');
    expect(validateFigureSpec({ ...formula, compare: [{ name: 'bad', expression: 'x+unknown' }] }, 3)).toHaveProperty('error', expect.stringContaining('선언되지 않은 변수'));
    expect(validateFigureSpec({ ...formula, compare: [{ name: 'bad', expression: 'x+' }] }, 3)).toHaveProperty('error');
  });
  it('drops out-of-range pages and long quotes', () => {
    const result = validateFigureSpec({ ...base, kind: 'flow', sources: [{ page: 1, quote: 'a'.repeat(201) }, { page: 4, quote: 'bad' }], steps: [{ id: 'a', label: 'A', detail: 'A', page: 0 }, { id: 'b', label: 'B', detail: 'B', page: 2 }], edges: [] }, 3);
    expect(result).toHaveProperty('spec');
    if ('spec' in result && result.spec.kind === 'flow') {
      expect(result.spec.sources).toEqual([{ page: 1, quote: null }]);
      expect(result.spec.steps[0].page).toBeUndefined();
      expect(result.spec.steps[1].page).toBe(2);
    }
  });
  it('rejects unknown kinds and unordered box statistics', () => {
    expect(validateFigureSpec({ ...base, kind: 'unknown' }, 3)).toEqual({ error: '알 수 없는 kind: unknown' });
    expect(validateFigureSpec({ ...base, kind: 'box', yLabel: 'Y', groups: [{ name: 'A', min: 0, q1: 3, median: 2, q3: 4, max: 5 }] }, 3)).toHaveProperty('error');
  });
});
