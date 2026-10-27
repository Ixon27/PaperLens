import { describe, expect, it } from 'vitest';
import { alignTranslation } from '../src/server/tasks/translation';

const ranges: Array<[number, number]> = [
  [0, 10],
  [11, 30],
];

describe('alignTranslation', () => {
  it('pairs each translated sentence with its source range', () => {
    expect(alignTranslation(ranges, [' 첫 문장입니다. ', '둘째 문장입니다.'])).toEqual({
      ko: '첫 문장입니다. 둘째 문장입니다.',
      sentences: [
        [0, 10, '첫 문장입니다.'],
        [11, 30, '둘째 문장입니다.'],
      ],
    });
  });

  it('preserves paragraph text without inventing alignment when sentence counts differ', () => {
    expect(alignTranslation(ranges, ['합친 문장입니다.'])).toEqual({ ko: '합친 문장입니다.', sentences: null });
  });

  it('accepts a plain paragraph string', () => {
    expect(alignTranslation(ranges, ' 문단 번역입니다. ')).toEqual({ ko: '문단 번역입니다.', sentences: null });
  });

  it('rejects output with nothing to show', () => {
    expect(alignTranslation(ranges, 42)).toBeNull();
    expect(alignTranslation(ranges, ['', '  '])).toBeNull();
  });
});
