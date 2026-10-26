import { describe, expect, it } from 'vitest';
import { tidyForVault } from '../src/server/export/tidy';

describe('tidyForVault', () => {
  it('turns a bold-only line into a #### heading', () => {
    expect(tidyForVault('앞\n**용어**\n뒤')).toBe('앞\n#### 용어\n뒤');
  });
  it('spaces a closing ** before 한글', () => {
    expect(tidyForVault('**SCFAs**는 중요')).toBe('**SCFAs** 는 중요');
  });
  it('joins ** and (', () => {
    expect(tidyForVault('**SCFAs** (단쇄 지방산)')).toBe('**SCFAs**(단쇄 지방산)');
  });
  it('removes numeric citations but keeps [p.N]', () => {
    expect(tidyForVault('결과다 [12]. 근거 [p.3]')).toBe('결과다. 근거 [p.3]');
  });
  it('leaves $$ blocks and fences untouched', () => {
    const md = '본문 ,끝\n$$\na ,b [3]\n$$\n```\nx ,y\n```';
    expect(tidyForVault(md)).toBe('본문,끝\n$$\na ,b [3]\n$$\n```\nx ,y\n```');
  });
});
