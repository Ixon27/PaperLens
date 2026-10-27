import { describe, expect, it } from 'vitest';
import { normalizeMath } from '../src/web/markdown-math';

describe('normalizeMath', () => {
  it('moves $$ glued to a multi-line formula onto their own lines', () => {
    expect(normalizeMath('$$\\begin{aligned}\nOD&\\leq x\n\\end{aligned}$$\n- after')).toBe(
      '$$\n\\begin{aligned}\nOD&\\leq x\n\\end{aligned}\n$$\n- after',
    );
  });

  it('splits a one-line display formula and keeps list indentation', () => {
    expect(normalizeMath('- 식:\n  $$a = b$$')).toBe('- 식:\n  $$\n  a = b\n  $$');
  });

  it('leaves code fences and inline $$ pairs alone', () => {
    const fenced = '```\n$$x\n```';
    expect(normalizeMath(fenced)).toBe(fenced);
    expect(normalizeMath('where $$x$$')).toBe('where $$x$$');
  });

  it('escapes an unmatched lone $$', () => {
    expect(normalizeMath('$$\na = b\n$$\n\ntext\n$$')).toBe('$$\na = b\n$$\n\ntext\n\\$\\$');
  });
});
