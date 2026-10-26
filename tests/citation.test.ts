import { describe, expect, it } from 'vitest';
import { detectBareNumber, detectCitation } from '../src/web/pdf/citation';

describe('detectCitation', () => {
  it('expands a numeric range around the offset', () => {
    const text = 'as shown [3–5].';
    expect(detectCitation(text, text.indexOf('–'))).toEqual({ kind: 'numeric', keys: ['3', '4', '5'] });
  });

  it('finds an author-year citation', () => {
    const text = 'reported before (Smith et al., 2020) in mice';
    expect(detectCitation(text, text.indexOf('et al'))).toEqual({ kind: 'author', family: 'Smith', year: '2020' });
  });

  it('ignores a plain year in prose', () => {
    const text = 'in 2020 we';
    expect(detectCitation(text, text.indexOf('2020'))).toBeNull();
  });

  it('rejects ranges over 30 numbers', () => {
    const text = 'reviewed in [1–40].';
    expect(detectCitation(text, text.indexOf('1'))).toBeNull();
  });
});

describe('detectBareNumber', () => {
  it('expands a superscript list', () => {
    expect(detectBareNumber('12,14')).toEqual(['12', '14']);
  });
});
