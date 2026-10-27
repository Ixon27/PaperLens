import { describe, expect, it } from 'vitest';
import { computeCoverage, type CoverageBlock } from '../src/shared/coverage';

const blocks: CoverageBlock[] = [
  { idx: 10, page: 1, kind: 'heading', text: 'Introduction', isRef: false },
  { idx: 11, page: 1, kind: 'body', text: 'The original introduction describes an important open problem.', isRef: false },
  { idx: 12, page: 2, kind: 'heading', text: 'Methods', isRef: false },
  { idx: 13, page: 2, kind: 'body', text: 'We measured growth across three experimental conditions.', isRef: false },
  { idx: 14, page: 2, kind: 'heading', text: 'Results', isRef: false },
  { idx: 15, page: 3, kind: 'body', text: 'The treated group showed substantially greater growth.', isRef: false },
];

describe('computeCoverage', () => {
  it('uses a resolved quote to cover exactly its section and reports missing sections', () => {
    const result = computeCoverage(blocks, '[p.2 "We measured growth across three experimental conditions"]');
    expect(result.sections).toEqual([
      { idx: 10, title: 'Introduction', covered: false },
      { idx: 12, title: 'Methods', covered: true },
      { idx: 14, title: 'Results', covered: false },
    ]);
    expect(result).toMatchObject({ total: 3, covered: 1, citations: 1, located: 1 });
  });

  it('covers every section on the cited page', () => {
    const result = computeCoverage(blocks, '[p.2]');
    expect(result.sections.map((section) => section.covered)).toEqual([false, true, true]);
    expect(result).toMatchObject({ covered: 2, citations: 1, located: 0 });
  });

  it('counts only resolved quotes and falls back to page coverage when missing', () => {
    const result = computeCoverage(blocks, '[p.1 "words not present in this paper"][p.3 "The treated group showed substantially greater growth"]');
    expect(result.sections.map((section) => section.covered)).toEqual([true, false, true]);
    expect(result).toMatchObject({ citations: 2, located: 1 });
  });
});
