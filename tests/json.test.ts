import { describe, expect, it } from 'vitest';
import { parseJsonLoose } from '../src/server/json';

describe('parseJsonLoose', () => {
  it('parses a fenced JSON object', () => {
    expect(parseJsonLoose('```json\n{"12": "번역", "13": "문단"}\n```')).toEqual({ '12': '번역', '13': '문단' });
  });

  it('skips leading prose and parses an array', () => {
    expect(parseJsonLoose<{ key: string }[]>('다음은 결과입니다:\n[{"key":"1"},{"key":"2"}]\n끝.')).toEqual([{ key: '1' }, { key: '2' }]);
  });

  it('reports broken JSON with a uniform Korean prefix', () => {
    expect(() => parseJsonLoose('{"a": 1,, }')).toThrow(/^JSON 파싱 실패/);
    expect(() => parseJsonLoose('no json here')).toThrow(/^JSON 파싱 실패/);
  });
});
