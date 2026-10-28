import { describe, expect, it } from 'vitest';
import { splitKoreanSentences, splitSentences } from '../src/server/pdf/sentences';

const sentences = (text: string) => splitSentences(text).map(([s, e]) => text.slice(s, e));

describe('splitSentences', () => {
  it('does not end sentences at genus abbreviations, initials, Fig. or et al.', () => {
    const text =
      'Lcb. rhamnosus S3 demonstrated the highest potential. Limosilactobacillus sp. (S1) showed activity against C. acnes. Results are in Fig. 2 and et al. [19]. Done.';
    const out = sentences(text);
    expect(out).toHaveLength(4);
    expect(out[1].startsWith('Limosilactobacillus')).toBe(true);
    expect(out[3]).toBe('Done.');
  });

  it('keeps decimals and closes after a parenthesis', () => {
    expect(sentences('Values were 2.5 mg (p < 0.05). The rest')).toEqual(['Values were 2.5 mg (p < 0.05).', 'The rest']);
  });

  it('keeps a section number with its heading but ends a sentence at a closing number', () => {
    expect(sentences('1. Introduction')).toEqual(['1. Introduction']);
    expect(sentences('The total was 12. Next came more.')).toEqual(['The total was 12.', 'Next came more.']);
  });

  it('keeps technical abbreviations within a sentence', () => {
    expect(sentences('See Sec. 3 and Thm. 2.1 for details.')).toEqual(['See Sec. 3 and Thm. 2.1 for details.']);
  });

  it('ends a sentence after a numeric measurement in kelvin', () => {
    expect(sentences('It was measured at 300 K. The gap closed.')).toEqual(['It was measured at 300 K.', 'The gap closed.']);
  });

  it.each([
    ['Cells were incubated for 30 min.', 'After incubation, cells were washed.'],
    ['Samples were held at 37 ◦C.', 'Cell viability was measured.'],
    ['The optical density was 0.5.', 'Wells without inoculation were controls.'],
  ])('ends a sentence after a numeric value or unit: %s', (first, next) => {
    expect(sentences(`${first} ${next}`)).toEqual([first, next]);
  });
});

describe('splitKoreanSentences', () => {
  const koreanSentences = (text: string) => splitKoreanSentences(text).map(([s, e]) => text.slice(s, e));

  it('recognizes Hangul starts without splitting mixed Latin scientific terminology', () => {
    const parts = [
      'Lcb. rhamnosus S3가 가장 높은 활성을 보였습니다.',
      'Limosilactobacillus sp. (S1)는 C. acnes를 억제했습니다.',
      '다른 Limosilactobacillus sp. (S2)도 비교했습니다.',
      'Fig. 2와 Eq. 3의 값은 2.5 mg (p < 0.05)였습니다.',
      '선행 연구는 Smith et al. [19]과 일치했습니다.',
      '결과는 e.g. LAB와 S. aureus에 적용됩니다.',
      '인용 결과도 확인했습니다 [20].',
      '“마지막 문장입니다.”',
    ];
    expect(koreanSentences(parts.join(' '))).toEqual(parts);
  });

  it('recognizes lowercase technical terms with Korean particles without splitting genus abbreviations', () => {
    const parts = ['용액을 준비하였다.', 'pH는 6.5로 조정하였다.', 'Lcb. rhamnosus는 생존하였다.', 'biofilm은 감소하였다.'];
    expect(koreanSentences(parts.join(' '))).toEqual(parts);
  });

  it('keeps numeric section headings together', () => {
    expect(koreanSentences('1. 서론')).toEqual(['1. 서론']);
    expect(koreanSentences('2.1. 피부 및 타액 시료에서 미생물 분리')).toEqual(['2.1. 피부 및 타액 시료에서 미생물 분리']);
    expect(koreanSentences('합계는 12. 다음 값은 2.5입니다.')).toEqual(['합계는 12.', '다음 값은 2.5입니다.']);
  });

  it('retains exact offsets, internal whitespace and punctuation', () => {
    const text = '  첫  문장입니다.\n\t(다음 문장입니다.)  마지막입니다!  ';
    const ranges = splitKoreanSentences(text);
    expect(ranges.map(([s, e]) => text.slice(s, e))).toEqual(['첫  문장입니다.', '(다음 문장입니다.)', '마지막입니다!']);
    expect(ranges[0][0]).toBe(2);
    expect(ranges[2][1]).toBe(text.length - 2);
  });
});
