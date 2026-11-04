import { describe, expect, it } from 'vitest';
import { duplicatesNative, inlineRasterDivider, inlineUnionBox, nativeRegion, ocrGlyphRaster, overlaps, plainRaster, protectedSource, refineNativeBoxes, tokensPreserved, transformedBox, type Box } from '../src/server/pdf/layout-translation-geometry';

const item = { str: 'Measured value', transform: [10, 0, 0, 10, 20, 70], width: 40, height: 10, dir: 'ltr' };
const metrics = { ascent: 0.8, descent: -0.2 };
const viewport = { transform: [1, 0, 0, -1, 0, 100], scale: 1 };
function raster() {
  const data = new Uint8ClampedArray(100 * 60 * 4).fill(255);
  const ink = (x: number, y: number, rgb = [0, 0, 0]) => data.set([...rgb, 255], (y * 100 + x) * 4);
  return { data, ink };
}

describe('native layout geometry and protected scientific content', () => {
  it('composes the full viewport transform, ascent, descent and explicit one-point margin', () => {
    const region = nativeRegion(item, metrics, viewport, 'native');
    expect(region.box).toEqual([19, 21, 42, 12]);
    expect(region.fontSize).toBe(10);
    expect(region.safe).toBe(true);
    expect(nativeRegion(item, metrics, { ...viewport, transform: [1, 0, 0, -1, -10, 210] }, 'cropped').box).toEqual([9, 131, 42, 12]);
  });
  it('retains rotated geometry but never claims skew, vertical or unknown metrics are safe', () => {
    const rotated = nativeRegion(item, metrics, { ...viewport, transform: [0, 1, 1, 0, 0, 0] }, 'rotated');
    expect(rotated.box).toEqual([67, 19, 12, 42]);
    expect(rotated.rotation).toBe(90);
    expect(rotated.safe).toBe(false);
    expect(nativeRegion(item, undefined, viewport, 'unknown').safe).toBe(false);
    expect(nativeRegion({ ...item, transform: [10, 0, 3, 10, 20, 70] }, metrics, viewport, 'skew').safe).toBe(false);
    expect(nativeRegion(item, { ...metrics, vertical: true }, viewport, 'vertical').safe).toBe(false);
    expect(transformedBox([0, 1, -1, 0, 20, 30], 1, 2, 4, 6)).toEqual([14, 31, 4, 3]);
  });
  it.each(['42.0 ± 1.3', 'E = mc^2', 'α + β = 1', '123', '(12)', '∑x_i', 'https://doi.org/10.1038/s41587-025-02556-5', 'RAW264.7', '1 mg kg', 'pg ml', '62.5–1,000 ng ml', '(pg ml'])('preserves %s rather than inventing Korean', (source) => {
    expect(protectedSource(source)).toBe(true);
    const region = nativeRegion({ ...item, str: source }, metrics, viewport, 'protected');
    expect(region.kind).toBe('protected');
    expect(region.safe).toBe(false);
    expect(region.ko).toBeNull();
  });
  it('keeps prose translatable while requiring literal numeric precision, units and symbols', () => {
    expect(protectedSource('We measured 3.5 nM at 10 K')).toBe(false);
    expect(tokensPreserved('Measured -2.00 mV and α at 10 K', '10 K에서 α와 -2.00 mV를 측정했다')).toBe(true);
    for (const ko of ['10 K에서 α와 -2 mV를 측정했다', '10 K에서 β와 -2.00 mV를 측정했다', '10 K에서 α와 -2.00 V를 측정했다', '10 K에서 α와 2.00 mV를 측정했다']) expect(tokensPreserved('Measured -2.00 mV and α at 10 K', ko)).toBe(false);
    expect(tokensPreserved('RAW264.7 and mRNA-LNP at 10 K', '10 K에서 RAW264.7 및 mRNA-LNP')).toBe(true);
    expect(tokensPreserved('RAW264.7 and mRNA-LNP at 10 K', '10 K에서 RAW264.8 및 mRNA-LNP')).toBe(false);
  });
  it('partitions overlapping font metric rows only through a real white raster gutter', () => {
    const { data, ink } = raster();
    const first = { ...nativeRegion(item, metrics, viewport, 'a'), box: [10, 10, 30, 14.34] as Box };
    const second = { ...nativeRegion(item, metrics, viewport, 'b'), box: [10, 24, 30, 14.34] as Box };
    for (let y = 14; y <= 20; y++) ink(20, y);
    for (let y = 28; y <= 34; y++) ink(20, y);
    expect(overlaps(first.box, second.box)).toBe(true);
    refineNativeBoxes([first, second], { data, width: 100, height: 60, scale: 1 });
    expect(overlaps(first.box, second.box)).toBe(false);
    expect(first.box[1] + first.box[3]).toBeCloseTo(24.17);
    expect(second.box[1]).toBeCloseTo(24.17);
    const crossedFirst = { ...first, box: [10, 10, 30, 14.34] as Box };
    const crossedSecond = { ...second, box: [10, 24, 30, 14.34] as Box };
    ink(20, 24); ink(20, 25);
    refineNativeBoxes([crossedFirst, crossedSecond], { data, width: 100, height: 60, scale: 1 });
    expect(crossedFirst.box).toEqual([10, 10, 30, 14.34]);
    expect(crossedSecond.box).toEqual([10, 24, 30, 14.34]);
  });
  it('can trim only a caption when its protected neighbor must keep a wider metric box', () => {
    const { data, ink } = raster();
    const caption = { ...nativeRegion(item, metrics, viewport, 'caption'), box: [10, 10, 30, 14.34] as Box };
    const marker = { ...nativeRegion({ ...item, str: 'a' }, metrics, viewport, 'marker'), box: [10, 24, 30, 14.34] as Box };
    ink(10, 30);
    refineNativeBoxes([caption, marker], { data, width: 100, height: 60, scale: 1 });
    expect(caption.box[1] + caption.box[3]).toBe(24);
    expect(marker.box).toEqual([10, 24, 30, 14.34]);
    expect(marker.kind).toBe('protected');
    expect(overlaps(caption.box, marker.box)).toBe(false);
  });
});

describe('OCR duplicate and raster drawing safety', () => {
  it('filters native overlap even when OCR misspells it; separate table cells survive', () => {
    const native = [{ box: [10, 10, 50, 12] as Box }];
    expect(duplicatesNative([12, 11, 40, 10], native)).toBe(true);
    expect(duplicatesNative([70, 10, 40, 10], native)).toBe(false);
    expect(duplicatesNative([0, 0, 0, 10], native)).toBe(true);
  });
  it('rejects nonwhite boundaries, colored backgrounds and long graph/table strokes', () => {
    const { data, ink } = raster();
    const box: Box = [10, 10, 70, 30];
    expect(plainRaster(data, 100, 60, box, 1, 12)).toBe(true);
    ink(10, 20);
    expect(plainRaster(data, 100, 60, box, 1, 12)).toBe(false);
    data.fill(255);
    for (let x = 20; x < 70; x++) ink(x, 25);
    expect(plainRaster(data, 100, 60, box, 1, 12)).toBe(false);
    data.fill(230);
    expect(plainRaster(data, 100, 60, box, 1, 12)).toBe(false);
  });
  it('allows isolated OCR glyphs, but not unexplained ink, low confidence or colored plot pixels', () => {
    const { data, ink } = raster();
    for (let y = 20; y < 32; y++) { ink(20, y); ink(25, y); ink(33, y); }
    for (let x = 20; x <= 25; x++) ink(x, 25);
    const symbols = [{ text: 'H', confidence: 99, box: [20, 20, 6, 12] as Box }, { text: 'I', confidence: 99, box: [32, 20, 3, 12] as Box }];
    const box: Box = [17, 17, 21, 18];
    expect(ocrGlyphRaster(data, 100, 60, box, 1, 12, symbols)).toBe(true);
    ink(28, 25, [160, 160, 160]);
    expect(ocrGlyphRaster(data, 100, 60, box, 1, 12, symbols)).toBe(true);
    ink(28, 25);
    expect(ocrGlyphRaster(data, 100, 60, box, 1, 12, symbols)).toBe(false);
    data.set([255, 255, 255, 255], (25 * 100 + 28) * 4);
    expect(ocrGlyphRaster(data, 100, 60, box, 1, 12, symbols.map((symbol) => ({ ...symbol, confidence: 60 })))).toBe(false);
    ink(29, 29);
    expect(ocrGlyphRaster(data, 100, 60, box, 1, 12, symbols)).toBe(false);
    data.set([255, 255, 255, 255], (29 * 100 + 29) * 4);
    ink(20, 21, [200, 0, 0]);
    expect(ocrGlyphRaster(data, 100, 60, box, 1, 12, symbols)).toBe(false);
  });
  it('joins narrow inline gaps but not columns, vector cell borders or raster table rules', () => {
    const left: Box = [10, 10, 20, 14], right: Box = [32, 10, 24, 14];
    expect(inlineUnionBox(left, right, 12, [])).toEqual([10, 10, 46, 14]);
    expect(inlineUnionBox([8, 8, 24, 18], [30, 8, 28, 18], 12, [], 2)).toEqual([8, 8, 50, 18]);
    expect(inlineUnionBox(left, [60, 10, 20, 14], 12, [])).toBeNull();
    expect(inlineUnionBox(left, right, 12, [[30, 0, 1, 40]])).toBeNull();
    const { data, ink } = raster();
    expect(inlineRasterDivider(data, 100, 60, left, right, 1, 12)).toBe(false);
    for (let y = 8; y < 28; y++) ink(31, y);
    expect(inlineRasterDivider(data, 100, 60, left, right, 1, 12)).toBe(true);
  });
});
