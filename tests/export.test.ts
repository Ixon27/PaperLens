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
    expect(convertPageRefs('근거 [p.3 "the strain grew"]', 'x.pdf')).toBe('근거 [[x.pdf#page=3|p.3]]');
  });
  it('escapes wiki link separators in markdown table cells only', () => {
    const md = [
      '| 구분 | 내용 |',
      '|---|---|',
      '| 핵심 | 결과 [p.3 "the strain grew"] |',
      '| Gap | 근거 [p.4] |',
      '',
      '본문 [p.5]',
      '',
      '```',
      '| 구분 | 내용 |',
      '|---|---|',
      '| 예시 | [p.6] |',
      '```',
    ].join('\n');
    expect(convertPageRefs(md, 'x.pdf')).toBe([
      '| 구분 | 내용 |',
      '|---|---|',
      '| 핵심 | 결과 [[x.pdf#page=3\\|p.3]] |',
      '| Gap | 근거 [[x.pdf#page=4\\|p.4]] |',
      '',
      '본문 [[x.pdf#page=5|p.5]]',
      '',
      '```',
      '| 구분 | 내용 |',
      '|---|---|',
      '| 예시 | [[x.pdf#page=6|p.6]] |',
      '```',
    ].join('\n'));
  });
  it('handles tables without outer pipes and leaves unlinked pages alone', () => {
    const md = '내용 [p.1] | 값\n--- | ---\n설명 [p.2] | 10';
    expect(convertPageRefs(md, 'x.pdf')).toBe('내용 [[x.pdf#page=1\\|p.1]] | 값\n--- | ---\n설명 [[x.pdf#page=2\\|p.2]] | 10');
    expect(convertPageRefs(md, null)).toBe('내용 (p.1) | 값\n--- | ---\n설명 (p.2) | 10');
  });
  it('shifts headings', () => {
    expect(shiftHeadings('#### A\n##### B\n###### C\n```\n#### code\n```')).toBe('## A\n### B\n#### C\n```\n#### code\n```');
  });
});
