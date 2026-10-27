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
  it('rejects mismatched arrays and undeclared formula variables', () => {
    expect(validateFigureSpec({ ...base, kind: 'bar', yLabel: 'Y', categories: ['A', 'B'], series: [{ name: 'S', values: [1] }] }, 3)).toHaveProperty('error');
    expect(validateFigureSpec({ ...base, kind: 'formula', expression: 'x+y', latex: 'x+y', x: { name: 'x', label: 'X', min: 0, max: 1 }, yLabel: 'Y', variables: [] }, 3)).toHaveProperty('error');
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
