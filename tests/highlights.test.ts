import { expect, it } from 'vitest';
import groupHighlightsByPage from '../src/web/pdf/group-highlights-by-page';

it('renders each multiline highlight once per page instead of stacking the same colour once per line', () => {
  const line = (pageNumber: number, y1: number) => ({ pageNumber, x1: 10, y1, x2: 90, y2: y1 + 10, width: 100, height: 200 });
  const lines = [line(3, 10), line(3, 25), line(4, 10)];
  const h = { id: 'note', position: { boundingRect: lines[0], rects: lines } };
  const grouped = groupHighlightsByPage([null, h]);
  expect(grouped[3]).toEqual([{ ...h, position: { ...h.position, rects: lines.slice(0, 2) } }]);
  expect(grouped[4]).toEqual([{ ...h, position: { ...h.position, rects: lines.slice(2) } }]);
});
