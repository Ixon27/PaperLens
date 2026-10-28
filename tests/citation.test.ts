import { describe, expect, it } from 'vitest';
import { detectBareNumber, detectCitation } from '../src/web/pdf/citation';

describe('detectCitation', () => {
  it('expands a numeric range around the offset', () => {
    const text = 'as shown [3–5].';
    expect(detectCitation(text, text.indexOf('–'), { parens: true })).toEqual({ kind: 'numeric', keys: ['3', '4', '5'] });
  });

  it('finds an author-year citation', () => {
    const text = 'reported before (Smith et al., 2020) in mice';
    expect(detectCitation(text, text.indexOf('et al'), { parens: true })).toEqual({ kind: 'author', family: 'Smith', year: '2020' });
  });

  it('ignores a plain year in prose', () => {
    const text = 'in 2020 we';
    expect(detectCitation(text, text.indexOf('2020'), { parens: true })).toBeNull();
  });

  it('rejects ranges over 30 numbers', () => {
    const text = 'reviewed in [1–40].';
    expect(detectCitation(text, text.indexOf('1'), { parens: true })).toBeNull();
  });

  it('gates parentheses and excludes equation references', () => {
    const equation = 'as in Eq. (3) we';
    expect(detectCitation(equation, equation.indexOf('3'), { parens: true })).toBeNull();
    const text = 'growth (3) was';
    expect(detectCitation(text, text.indexOf('3'), { parens: true })).toEqual({ kind: 'numeric', keys: ['3'] });
    expect(detectCitation(text, text.indexOf('3'), { parens: false })).toBeNull();
  });

  it('rejects zero and expands four-digit unicode minus ranges', () => {
    const interval = 'x ∈ [0,1] holds';
    expect(detectCitation(interval, interval.indexOf('0'), { parens: true })).toBeNull();
    const text = '[1000−1002]';
    expect(detectCitation(text, 2, { parens: false })).toEqual({ kind: 'numeric', keys: ['1000', '1001', '1002'] });
  });

  it('recognizes historical and Unicode author names', () => {
    expect(detectCitation('Gauss 1809', 0, { parens: true })).toEqual({ kind: 'author', family: 'Gauss', year: '1809' });
    expect(detectCitation('Erdős 1959', 0, { parens: true })).toEqual({ kind: 'author', family: 'Erdős', year: '1959' });
  });
});

describe('detectBareNumber', () => {
  it('expands a superscript list', () => {
    expect(detectBareNumber('12,14')).toEqual(['12', '14']);
  });
});
