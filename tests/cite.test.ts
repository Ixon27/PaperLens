import { describe, expect, it } from 'vitest';
import { linkPageCites, pageCiteRe, pageCites, parsePageHref } from '../src/shared/cite';

describe('page citations', () => {
  it('links page, range, and quoted citations', () => {
    expect(linkPageCites('[p.3] [p.3–4] [p.3 "the strain grew"] [p.2 “curly quote”]'))
      .toBe('[p.3](#p-3) [p.3–4](#p-3-4) [p.3](#p-3~the%20strain%20grew) [p.2](#p-2~curly%20quote)');
    expect(pageCites('[p.3] [p.3-4 “ quoted ”]')).toEqual([
      { page: 3, endPage: null, quote: null },
      { page: 3, endPage: 4, quote: 'quoted' },
    ]);
    expect(pageCiteRe()).not.toBe(pageCiteRe());
  });

  it('encodes Markdown-sensitive parentheses and round-trips quotes', () => {
    const linked = linkPageCites('[p.3–4 "  50% (한국어)  "]');
    expect(linked).toBe('[p.3–4](#p-3-4~50%25%20%28%ED%95%9C%EA%B5%AD%EC%96%B4%29)');
    expect(parsePageHref(linked.slice(linked.indexOf('(#') + 1, -1))).toEqual({
      page: 3, endPage: 4, quote: '50% (한국어)',
    });
  });

  it('rejects malformed hrefs and invalid percent escapes', () => {
    expect(parsePageHref('#p-x')).toBeNull();
    expect(parsePageHref('#p-3~%ZZ')).toBeNull();
    expect(parsePageHref('#p-3-extra')).toBeNull();
  });
});
