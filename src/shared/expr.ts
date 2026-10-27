export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExprError';
  }
}

export type Expr =
  | { type: 'number'; value: number }
  | { type: 'name'; name: string }
  | { type: 'unary'; op: '+' | '-'; value: Expr }
  | { type: 'binary'; op: '+' | '-' | '*' | '/' | '^'; left: Expr; right: Expr }
  | { type: 'call'; name: string; args: Expr[] };

const functions: Record<string, { min: number; max: number; fn: (...args: number[]) => number }> = {
  exp: { min: 1, max: 1, fn: Math.exp },
  ln: { min: 1, max: 1, fn: Math.log },
  log: { min: 1, max: 1, fn: Math.log },
  log10: { min: 1, max: 1, fn: Math.log10 },
  log2: { min: 1, max: 1, fn: Math.log2 },
  sqrt: { min: 1, max: 1, fn: Math.sqrt },
  abs: { min: 1, max: 1, fn: Math.abs },
  sin: { min: 1, max: 1, fn: Math.sin },
  cos: { min: 1, max: 1, fn: Math.cos },
  tan: { min: 1, max: 1, fn: Math.tan },
  tanh: { min: 1, max: 1, fn: Math.tanh },
  min: { min: 1, max: Infinity, fn: Math.min },
  max: { min: 1, max: Infinity, fn: Math.max },
  pow: { min: 2, max: 2, fn: Math.pow },
};

export function parseExpr(src: string): Expr {
  if (src.length > 300) throw new ExprError('수식은 300자를 넘을 수 없습니다');
  let pos = 0;
  const space = () => { while (/\s/.test(src[pos] ?? '') && pos < src.length) pos++; };
  const take = (s: string) => {
    space();
    if (src[pos] !== s) return false;
    pos++;
    return true;
  };
  const depthCheck = (depth: number) => {
    if (depth > 40) throw new ExprError('수식이 너무 깊게 중첩되어 있습니다');
  };

  function primary(depth: number): Expr {
    depthCheck(depth);
    space();
    if (take('(')) {
      const value = sum(depth + 1);
      if (!take(')')) throw new ExprError('닫는 괄호가 필요합니다');
      return value;
    }
    space();
    const rest = src.slice(pos);
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) {
      pos += number[0].length;
      return { type: 'number', value: Number(number[0]) };
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (identifier) {
      const name = identifier[0];
      pos += name.length;
      if (!take('(')) return { type: 'name', name };
      if (!Object.hasOwn(functions, name)) throw new ExprError(`알 수 없는 함수: ${name}`);
      const args: Expr[] = [];
      if (!take(')')) {
        do { args.push(sum(depth + 1)); } while (take(','));
        if (!take(')')) throw new ExprError('닫는 괄호가 필요합니다');
      }
      const f = functions[name];
      if (args.length < f.min || args.length > f.max) throw new ExprError(`함수 ${name}의 인자 개수가 올바르지 않습니다`);
      return { type: 'call', name, args };
    }
    throw new ExprError('올바른 수식이 아닙니다');
  }

  function power(depth: number): Expr {
    depthCheck(depth);
    const left = primary(depth);
    return take('^') ? { type: 'binary', op: '^', left, right: unary(depth + 1) } : left;
  }
  function unary(depth: number): Expr {
    depthCheck(depth);
    if (take('+')) return { type: 'unary', op: '+', value: unary(depth + 1) };
    if (take('-')) return { type: 'unary', op: '-', value: unary(depth + 1) };
    return power(depth);
  }
  function product(depth: number): Expr {
    let left = unary(depth);
    for (;;) {
      if (take('*')) left = { type: 'binary', op: '*', left, right: unary(depth) };
      else if (take('/')) left = { type: 'binary', op: '/', left, right: unary(depth) };
      else return left;
    }
  }
  function sum(depth: number): Expr {
    let left = product(depth);
    for (;;) {
      if (take('+')) left = { type: 'binary', op: '+', left, right: product(depth) };
      else if (take('-')) left = { type: 'binary', op: '-', left, right: product(depth) };
      else return left;
    }
  }
  const expr = sum(0);
  space();
  if (pos !== src.length) throw new ExprError('수식에 해석할 수 없는 문자가 있습니다');
  return expr;
}

export function evalExpr(expr: Expr, vars: Record<string, number>): number {
  switch (expr.type) {
    case 'number': return expr.value;
    case 'name':
      if (expr.name === 'pi') return Math.PI;
      if (expr.name === 'e') return Math.E;
      if (!Object.hasOwn(vars, expr.name) || typeof vars[expr.name] !== 'number') throw new ExprError(`알 수 없는 변수: ${expr.name}`);
      return vars[expr.name];
    case 'unary': {
      const value = evalExpr(expr.value, vars);
      return expr.op === '-' ? -value : value;
    }
    case 'binary': {
      const left = evalExpr(expr.left, vars);
      const right = evalExpr(expr.right, vars);
      switch (expr.op) {
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/': return left / right;
        case '^': return left ** right;
      }
    }
    case 'call': {
      if (!Object.hasOwn(functions, expr.name)) throw new ExprError(`알 수 없는 함수: ${expr.name}`);
      const f = functions[expr.name];
      if (expr.args.length < f.min || expr.args.length > f.max) throw new ExprError(`함수 ${expr.name}의 인자 개수가 올바르지 않습니다`);
      return f.fn(...expr.args.map((arg) => evalExpr(arg, vars)));
    }
  }
}

export function exprNames(expr: Expr): Set<string> {
  const names = new Set<string>();
  function visit(node: Expr): void {
    switch (node.type) {
      case 'name': names.add(node.name); break;
      case 'unary': visit(node.value); break;
      case 'binary': visit(node.left); visit(node.right); break;
      case 'call': node.args.forEach(visit); break;
    }
  }
  visit(expr);
  return names;
}
