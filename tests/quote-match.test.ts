import { describe, expect, it } from 'vitest';
import { findQuote, type QuoteBlock } from '../src/shared/quote-match';

const block = (idx: number, page: number, text: string, isRef = false): QuoteBlock => ({ idx, page, text, isRef });

describe('findQuote', () => {
  it('returns offsets into the original text, including supplementary characters', () => {
    const text = 'Before: 𐐀 remarkable result! After';
    const hit = findQuote([block(1, 2, text)], 2, null, '𐐀 remarkable result');
    expect(hit).toEqual({ idx: 1, start: 8, end: text.indexOf('!') });
    expect(text.slice(hit!.start, hit!.end)).toBe('𐐀 remarkable result');
    const ending = 'A remarkable result 𐐀';
    expect(findQuote([block(2, 2, ending)], 2, null, ending)?.end).toBe(ending.length);
  });

  it('ignores hyphenation and line breaks', () => {
    const text = 'The dis-\ntribution was measured.';
    const hit = findQuote([block(1, 1, text)], 1, null, 'distribution was measured');
    expect(text.slice(hit!.start, hit!.end)).toBe('dis-\ntribution was measured');
  });

  it('normalizes ligatures, case and curly quotation marks', () => {
    const text = 'A “signiﬁcant result” appeared.';
    const hit = findQuote([block(1, 1, text)], 1, null, 'SIGNIFICANT "result" appeared');
    expect(text.slice(hit!.start, hit!.end)).toBe('signiﬁcant result” appeared');
  });

  it('searches the specified pages before neighbors and other pages', () => {
    const text = 'a sufficiently long quotation';
    const blocks = [block(1, 8, text), block(2, 2, text), block(3, 3, text)];
    expect(findQuote(blocks, 3, 4, text)?.idx).toBe(3);
    expect(findQuote(blocks.slice(0, 2), 3, null, text)?.idx).toBe(2);
    expect(findQuote(blocks.slice(0, 1), 3, null, text)?.idx).toBe(1);
  });

  it('rejects short quotes', () => {
    expect(findQuote([block(1, 1, 'short quote')], 1, null, 'short quote')).toBeNull();
  });

  it('falls back to a prefix when a quotation crosses blocks', () => {
    const blocks = [block(1, 1, 'The remarkable result was clear after'), block(2, 1, 'further testing')];
    expect(findQuote(blocks, 1, null, 'The remarkable result was clear after further testing')?.idx).toBe(1);
  });

  it('uses the suffix fallback and ignores reference blocks', () => {
    const quote = 'the remarkable experimental result was clear';
    const blocks = [block(1, 1, quote, true), block(2, 1, 'experimental result was clear')];
    expect(findQuote(blocks, 1, null, quote)?.idx).toBe(2);
    expect(findQuote([blocks[0]], 1, null, quote)).toBeNull();
  });
});
