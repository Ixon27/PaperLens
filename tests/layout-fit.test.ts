import { describe, expect, it } from 'vitest';
import { fitLayoutText, layoutBoxesOverlap, layoutBoxWithinPage, type LayoutTextMetrics } from '../src/shared/layout-fit';

// Geometry is deliberately independent of installed platform fonts.
function measure(text: string, size: number): LayoutTextMetrics {
  const width = Array.from(new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(text)).length * size;
  return { width, actualBoundingBoxLeft: 0, actualBoundingBoxRight: width, actualBoundingBoxAscent: size * 0.8, actualBoundingBoxDescent: size * 0.2 };
}

describe('layout translation fitting geometry', () => {
  it('keeps every Korean grapheme and explicit line break within its bounds', () => {
    const result = fitLayoutText({ text: '한글👨‍👩‍👧‍👦가\n나가', box: [10, 20, 30, 40], fontSize: 10, padding: 0, measure });
    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.lines.map((line) => line.text)).toEqual(['한글👨‍👩‍👧‍👦', '가', '나가']);
    expect(result.lines.every((line) => line.x >= 10 && line.x + line.width <= 40)).toBe(true);
    expect(result.lines.every((line) => line.baseline - 8 >= 20 && line.baseline + 2 <= 60)).toBe(true);
  });

  it('shrinks to the exact readable minimum rather than truncating the text', () => {
    const result = fitLayoutText({ text: '한글번역', box: [0, 0, 14, 16], fontSize: 10, minFontSize: 7, padding: 0, measure });
    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.fontSize).toBe(7);
    expect(result.lines.map((line) => line.text).join('')).toBe('한글번역');
  });

  it('reports overflow without a clipped or partial successful result', () => {
    expect(fitLayoutText({ text: '한글번역을모두보존', box: [0, 0, 14, 7], fontSize: 10, padding: 0, measure }))
      .toEqual({ fits: false, reason: expect.stringContaining('최소 가독 크기') });
    expect(fitLayoutText({ text: '한', box: [0, 0, 6, 20], fontSize: 10, minFontSize: 1, padding: 0, measure }).fits).toBe(false);
  });

  it('accounts for real left and right ink overhang, ascent and descent', () => {
    const overhang = (text: string, size: number): LayoutTextMetrics => ({
      ...measure(text, size), actualBoundingBoxLeft: 2, actualBoundingBoxRight: text.length * size + 3,
    });
    const result = fitLayoutText({ text: '한글', box: [20, 30, 25, 15], fontSize: 10, padding: 0, measure: overhang });
    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.lines[0].x).toBe(22);
    expect(result.lines[0].width).toBe(25);
    const tooTall = (text: string, size: number) => ({ ...measure(text, size), actualBoundingBoxAscent: 20, actualBoundingBoxDescent: 10 });
    expect(fitLayoutText({ text: '한글', box: [0, 0, 100, 20], fontSize: 10, padding: 0, measure: tooTall }).fits).toBe(false);
  });

  it('bases baselines on actual translated glyphs rather than a shorter sample glyph', () => {
    const realUnequalMetrics = (text: string, size: number): LayoutTextMetrics => ({
      width: text.length * size,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: text.length * size,
      // Observed browser Noto metrics at 7px: 집단 rises above 한글Mg by about 0.007px.
      actualBoundingBoxAscent: (text.includes('집단') ? 5.789000034 : 5.781999588) * (size / 7),
      actualBoundingBoxDescent: size * 0.2,
    });
    const result = fitLayoutText({
      text: '집단', box: [31.37, 42.19, 50, 20], fontSize: 7, padding: 0.75, measure: realUnequalMetrics,
    });
    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.fontSize).toBe(7);
    expect(result.lines[0].baseline).toBe(42.19 + 0.75 + 5.789000034);
    expect(result.lines[0].text).toBe('집단');
  });

  it('uses the tallest actual wrapped line while preserving exact vertical bounds', () => {
    const varyingMetrics = (text: string, size: number): LayoutTextMetrics => ({
      ...measure(text, size),
      actualBoundingBoxAscent: text.includes('집') ? size * 0.9 : size * 0.8,
      actualBoundingBoxDescent: text.includes('단') ? size * 0.3 : size * 0.2,
    });
    const result = fitLayoutText({
      text: '집\n단', box: [0, 0, 50, 25], fontSize: 10, padding: 0, measure: varyingMetrics,
    });
    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.lines.map((line) => line.baseline)).toEqual([9, 21.5]);
    expect(result.lines[1].baseline + 3).toBeLessThanOrEqual(25);
    const tooShort = fitLayoutText({
      text: '집\n단', box: [0, 0, 50, 24], fontSize: 10, minFontSize: 10, padding: 0, measure: varyingMetrics,
    });
    expect(tooShort.fits).toBe(false);
  });

  it('rejects invalid geometry and failed measurements', () => {
    for (const box of [[0, 0, 0, 10], [NaN, 0, 10, 10], [0, 0, 10, -1]] as [number, number, number, number][]) {
      expect(fitLayoutText({ text: '한글', box, fontSize: 10, measure }).fits).toBe(false);
    }
    expect(fitLayoutText({ text: '한글', box: [0, 0, 100, 100], fontSize: 10, measure: () => ({ width: NaN }) }).fits).toBe(false);
    expect(fitLayoutText({ text: '한글', box: [0, 0, 100, 100], fontSize: Infinity, measure }).fits).toBe(false);
  });

  it('treats touching edges as separate but rejects partial page boundaries', () => {
    expect(layoutBoxesOverlap([0, 0, 10, 10], [10, 0, 5, 5])).toBe(false);
    expect(layoutBoxesOverlap([0, 0, 10, 10], [9.99, 0, 5, 5])).toBe(true);
    expect(layoutBoxWithinPage([0, 0, 100, 200], 100, 200)).toBe(true);
    expect(layoutBoxWithinPage([-0.01, 0, 100, 100], 100, 200)).toBe(false);
    expect(layoutBoxWithinPage([0, 0, 100.01, 100], 100, 200)).toBe(false);
  });
});
