import { describe, expect, it } from 'vitest';
import { OPS, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { layoutDrawingBounds } from '../src/server/pdf/layout-translation';
import { overlaps, type Box } from '../src/server/pdf/layout-translation-geometry';

function page(operations: Array<[number, unknown[]]>): PDFPageProxy {
  return {
    getViewport: () => ({ width: 300, height: 300, transform: [1, 0, 0, -1, 0, 300], scale: 1 }),
    getOperatorList: async () => ({ fnArray: operations.map(([op]) => op), argsArray: operations.map(([, args]) => args) }),
  } as unknown as PDFPageProxy;
}
const caption: Box = [40, 200, 200, 20];
const figure: Box = [60, 60, 20, 20];

describe('bounded PDF drawing coverage', () => {
  it('protects a transparency group without blanket-protecting a separate figure caption', async () => {
    const result = await layoutDrawingBounds(page([
      [OPS.beginGroup, [{ matrix: [1, 0, 0, 1, 0, 0], bbox: [40, 160, 180, 260], isolated: true }]],
      [OPS.constructPath, [[OPS.rectangle], [40, 160, 140, 100], [40, 160, 180, 260]]],
      [OPS.fill, []],
      [OPS.endGroup, []],
    ]));
    expect(result.uncertain).toBe(false);
    expect(result.boxes.some((box) => overlaps(box, figure))).toBe(true);
    expect(result.boxes.some((box) => overlaps(box, caption))).toBe(false);
  });
  it('limits shading coverage to the saved clip instead of the whole page', async () => {
    const result = await layoutDrawingBounds(page([
      [OPS.save, []],
      [OPS.constructPath, [[OPS.rectangle], [40, 160, 140, 100], [40, 160, 180, 260]]],
      [OPS.clip, []],
      [OPS.endPath, []],
      [OPS.shadingFill, ['gradient']],
      [OPS.restore, []],
    ]));
    expect(result.uncertain).toBe(false);
    expect(result.boxes).toEqual([[40, 40, 140, 100]]);
    expect(result.boxes.some((box) => overlaps(box, caption))).toBe(false);
  });
  it('still protects unbounded full-page shading and malformed graphics groups', async () => {
    const shading = await layoutDrawingBounds(page([[OPS.shadingFill, ['gradient']]]));
    expect(shading.boxes.some((box) => overlaps(box, caption))).toBe(true);
    const malformed = await layoutDrawingBounds(page([[OPS.beginGroup, [{}]], [OPS.endGroup, []]]));
    expect(malformed.uncertain).toBe(true);
  });
});
