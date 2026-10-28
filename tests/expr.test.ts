import { describe, expect, it } from 'vitest';
import { evalExpr, ExprError, exprNames, parseExpr } from '../src/shared/expr';

const evaluate = (src: string, vars: Record<string, number> = {}) => evalExpr(parseExpr(src), vars);

describe('expressions', () => {
  it('respects arithmetic precedence, right-associative powers and unary signs', () => {
    expect(evaluate('-2^2')).toBe(-4);
    expect(evaluate('2^3^2')).toBe(512);
    expect(evaluate('2**3**2')).toBe(512);
    expect(evaluate('-2**2')).toBe(-4);
    expect(evaluate('2^-2')).toBe(0.25);
    expect(evaluate('(-2)^2 + 3 * 4 - 6 / 2')).toBe(13);
    expect(evaluate('+.5 + 2e-3')).toBeCloseTo(0.502);
  });

  it('supports the whitelisted functions and constants', () => {
    expect(evaluate('exp(ln(e)) + log(e) + log10(100) + log2(8)')).toBeCloseTo(6 + Math.E);
    expect(evaluate('sqrt(9) + abs(-2) + sin(pi/2) + cos(0) + tan(0) + tanh(0)')).toBeCloseTo(7);
    expect(evaluate('min(3, 1, 2) + max(3, 1, 2) + pow(2, 3)')).toBe(12);
  });

  it('supports extended scientific functions', () => {
    expect(evaluate('asin(1)')).toBeCloseTo(Math.PI / 2);
    expect(evaluate('atan2(1,1)')).toBeCloseTo(Math.PI / 4);
    expect(evaluate('mod(-1,3)')).toBe(2);
    expect(evaluate('erf(1)')).toBeCloseTo(0.8427008, 6);
    expect(evaluate('erfc(1)')).toBeCloseTo(1 - 0.8427008, 6);
    expect(evaluate('gamma(5)')).toBeCloseTo(24, 9);
    expect(evaluate('gamma(0.5)')).toBeCloseTo(Math.sqrt(Math.PI), 9);
    expect(evaluate('gamma(-0.5)')).toBeCloseTo(-2 * Math.sqrt(Math.PI), 9);
    expect(evaluate('sigmoid(0)')).toBe(0.5);
    expect(evaluate('step(-1)+step(0)')).toBe(1);
    expect(evaluate('hypot(3,4)')).toBe(5);
    expect(evaluate('cbrt(27)')).toBe(3);
    expect(evaluate('acos(1)+atan(0)+sinh(0)+cosh(0)+asinh(0)+acosh(1)+atanh(0)')).toBe(1);
    expect(evaluate('floor(1.9)+ceil(1.1)+round(1.6)+sign(-2)+trunc(-1.9)')).toBe(3);
  });

  it('rejects unknown functions, invalid syntax and wrong arity', () => {
    for (const src of ['unknown(1)', 'constructor(1)', '1 + garbage!', '1e-', 'x.y', 'min()', 'pow(2)', 'sin(1, 2)', 'atan2(1)', 'mod(1)', 'hypot()', '(1', '']) {
      expect(() => parseExpr(src)).toThrow(ExprError);
    }
  });

  it('enforces source and nesting limits', () => {
    expect(() => parseExpr('1'.repeat(301))).toThrow(ExprError);
    expect(() => parseExpr('('.repeat(40) + '1' + ')'.repeat(40))).not.toThrow();
    expect(() => parseExpr('('.repeat(41) + '1' + ')'.repeat(41))).toThrow(ExprError);
    expect(() => parseExpr('-'.repeat(41) + '1')).toThrow(ExprError);
  });

  it('collects identifiers and evaluates declared variables', () => {
    const expr = parseExpr('sin(x) + scale*x + pi + e');
    expect(exprNames(expr)).toEqual(new Set(['x', 'scale', 'pi', 'e']));
    expect(evalExpr(expr, { x: 0, scale: 2 })).toBeCloseTo(Math.PI + Math.E);
    expect(() => evalExpr(expr, { x: 1 })).toThrow(ExprError);
  });

  it('does not expose inherited properties and permits nonfinite results', () => {
    expect(() => evaluate('constructor')).toThrow(ExprError);
    expect(() => evaluate('toString')).toThrow(ExprError);
    expect(evaluate('1/0')).toBe(Infinity);
    expect(evaluate('sqrt(-1)')).toBeNaN();
  });
});
