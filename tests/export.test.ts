import { describe, expect, it } from 'vitest';
import { authorsLine, citekey, convertPageRefs, journalLine, shiftHeadings } from '../src/server/export/obsidian';

const authors = [{ family: 'Müller', given: 'Anna B.' }];

describe('obsidian export helpers', () => {
  it('citekey strips diacritics', () => {
    expect(citekey({ authors, year: 2020 })).toBe('Muller2020');
    expect(citekey({ authors: [], year: null })).toBe('Unknownnd');
  });
  it('authorsLine uses initials', () => {
    expect(authorsLine(authors)).toBe('Müller AB');
  });
  it('journalLine', () => {
    expect(journalLine({ journal: 'Fermentation', volume: '12', issue: '5', pages: '216' })).toBe('Fermentation 12(5):216');
  });
  it('converts page refs', () => {
    expect(convertPageRefs('근거 [p.3–4]', 'MM/paper-reader/pdfs/x.pdf')).toBe('근거 [[MM/paper-reader/pdfs/x.pdf#page=3|p.3–4]]');
    expect(convertPageRefs('[p.7]', null)).toBe('(p.7)');
  });
  it('shifts headings', () => {
    expect(shiftHeadings('#### A\n##### B\n###### C\n```\n#### code\n```')).toBe('## A\n### B\n#### C\n```\n#### code\n```');
  });
});
