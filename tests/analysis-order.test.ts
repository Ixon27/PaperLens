import { describe, expect, it } from 'vitest';
import { orderSections } from '../src/server/tasks/analysis';

const headings = (md: string) => [...md.matchAll(/^#### (.+)$/gm)].map((m) => m[1]);

describe('orderSections', () => {
  it('merges the three calls in reading order, whatever order they were written in', () => {
    const md = orderSections(['#### 연구 적용\nA\n#### 요약\nB', '#### Results\nC', '#### 한계점\nD\n#### Abstract\nE']);
    expect(headings(md)).toEqual(['요약', 'Abstract', 'Results', '한계점', '연구 적용']);
    expect(md).toContain('#### 요약\nB');
  });

  it('keeps unknown sections after the known ones, in their original order', () => {
    const md = orderSections(['#### 기타 하나\nX\n#### 연구 적용\nY', '#### 기타 둘\nZ']);
    expect(headings(md)).toEqual(['연구 적용', '기타 하나', '기타 둘']);
  });

  it('reads an analysis written under the earlier section names like a new one', () => {
    const md = orderSections([
      [
        '#### 한 줄 메시지\nA',
        '#### 무엇을 왜 했나\nB',
        '#### 읽기 로드맵\n- 1단계',
        '#### 공부 단어장\n##### 분류\n###### Probiotic (프로바이오틱스)',
        '#### Methods — 따라 하면 재현되는 수준으로\nC',
        '#### Results — Figure 단위로, 수치를 그대로\nD',
        '#### Abstract 뜯어보기\nE',
        '#### Introduction 뜯어보기\nF',
        '#### Discussion 뜯어보기\nG',
        '#### 한계점 — 저자가 밝힌 것만\nH',
        '#### 핵심 개념 심층\n##### 공부 단어장\n###### 1. Autoaggregation\n- 정의',
        '#### 내 연구에 쓸 지점\nI',
      ].join('\n'),
    ]);
    expect(headings(md)).toEqual(['요약', 'Why', 'Abstract', 'Introduction', 'Methods', 'Results', 'Discussion', '한계점', '핵심 개념 심층', '연구 적용']);
    expect(md).not.toContain('단어장');
    expect(md).not.toContain('1단계');
    expect(md).toContain('#### 핵심 개념 심층\n###### 1. Autoaggregation\n- 정의');
  });
});
