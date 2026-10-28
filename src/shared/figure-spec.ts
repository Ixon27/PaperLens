import { parseExpr, exprNames, type Expr } from './expr.js';

export const FIGURE_KINDS = ['line', 'bar', 'scatter', 'stacked', 'box', 'heatmap', 'volcano', 'ordination', 'survival', 'doseResponse', 'formula', 'compare', 'table', 'flow', 'timeline', 'tree', 'network', 'venn', 'hotspot', 'histogram', 'field', 'roc'] as const;
export type FigureKind = typeof FIGURE_KINDS[number];
export const FIGURE_KIND_LABELS: Record<FigureKind, string> = {
  line: '선 그래프', bar: '막대 그래프', scatter: '산점도', stacked: '누적 막대', box: '박스플롯', heatmap: '히트맵', volcano: '볼케이노', ordination: '차원 축소(PCA 등)', survival: '생존·누적 곡선', doseResponse: 'S자 곡선(용량-반응)', formula: '수식 시뮬레이터', compare: '조건 비교', table: '정렬 표', flow: '단계 흐름도', timeline: '타임라인', tree: '계층 트리', network: '네트워크', venn: '벤 다이어그램', hotspot: '원본 그림 핫스팟(실험적)', histogram: '히스토그램', field: '등고선·필드 맵', roc: 'ROC·PR 곡선',
};
export const FIGURE_KIND_GROUPS: { label: string; kinds: FigureKind[] }[] = [
  { label: '데이터 차트', kinds: ['line', 'bar', 'scatter', 'stacked', 'box', 'heatmap', 'histogram', 'field'] },
  { label: '통계·분석', kinds: ['volcano', 'ordination', 'survival', 'roc', 'doseResponse'] },
  { label: '수식·표', kinds: ['formula', 'compare', 'table'] },
  { label: '구조·관계', kinds: ['flow', 'timeline', 'tree', 'network', 'venn'] },
  { label: '실험적', kinds: ['hotspot'] },
];
export function isFigureKind(value: unknown): value is FigureKind { return typeof value === 'string' && (FIGURE_KINDS as readonly string[]).includes(value); }

type Base<K extends FigureKind> = { kind: K; title: string; takeaway: string; howTo: string; approx: boolean; sources: { page: number; quote: string | null }[]; notes: string[] };
type XY = { x: number; y: number };
export type FigureTreeNode = { label: string; detail?: string; children?: FigureTreeNode[] };
export type FigureSpec =
  | (Base<'line'> & { xLabel: string; yLabel: string; xLog?: boolean; yLog?: boolean; series: { name: string; points: (XY & { err?: number })[] }[] })
  | (Base<'bar'> & { yLabel: string; categories: string[]; series: { name: string; values: (number | null)[]; errors?: (number | null)[] }[] })
  | (Base<'scatter'> & { xLabel: string; yLabel: string; xLog?: boolean; yLog?: boolean; points: (XY & { group?: string; label?: string })[] })
  | (Base<'stacked'> & { yLabel: string; samples: string[]; parts: { name: string; values: number[] }[] })
  | (Base<'box'> & { yLabel: string; groups: { name: string; min: number; q1: number; median: number; q3: number; max: number; mean?: number; n?: number }[] })
  | (Base<'heatmap'> & { rowLabel: string; colLabel: string; valueLabel: string; rows: string[]; cols: string[]; values: (number | null)[][]; diverging: boolean })
  | (Base<'histogram'> & { xLabel: string; yLabel: string; series: { name: string; bins: { x0: number; x1: number; count: number }[] }[] })
  | (Base<'field'> & { xLabel: string; yLabel: string; valueLabel: string; x: number[]; y: number[]; values: (number | null)[][]; diverging: boolean })
  | (Base<'roc'> & { mode: 'roc' | 'pr'; curves: { name: string; points: XY[]; auc?: number }[] })
  | (Base<'volcano'> & { xLabel: string; points: { label?: string; log2fc: number; p: number }[]; pThreshold: number; fcThreshold: number })
  | (Base<'ordination'> & { xLabel: string; yLabel: string; points: (XY & { group: string; label?: string })[] })
  | (Base<'survival'> & { timeLabel: string; yLabel?: string; groups: { name: string; steps: { t: number; s: number }[]; censored?: number[] }[] })
  | (Base<'doseResponse'> & { xLabel: string; yLabel: string; curves: { name: string; bottom: number; top: number; ec50: number; hill: number; points?: XY[] }[] })
  | (Base<'formula'> & { expression: string; latex: string; x: { name: string; label: string; min: number; max: number }; yLabel: string; variables: { name: string; label: string; min: number; max: number; step: number; value: number; unit?: string }[]; xLog?: boolean; yLog?: boolean; yMin?: number; yMax?: number; compare?: { name: string; expression: string }[] })
  | (Base<'compare'> & { conditions: string[]; metrics: { name: string; unit?: string; values: (number | null)[]; higherIsBetter?: boolean }[] })
  | (Base<'table'> & { columns: { key: string; label: string; numeric: boolean; unit?: string }[]; rows: Record<string, string | number | null>[]; highlight?: number[] })
  | (Base<'flow'> & { steps: { id: string; label: string; detail: string; page?: number }[]; edges: { from: string; to: string; label?: string }[] })
  | (Base<'timeline'> & { unit: string; events: { label: string; detail: string; start: number; end?: number; lane?: string }[] })
  | (Base<'tree'> & { root: FigureTreeNode })
  | (Base<'network'> & { nodes: { id: string; label: string; group?: string; detail?: string }[]; edges: { source: string; target: string; weight?: number; sign?: '+' | '-' }[] })
  | (Base<'venn'> & { sets: { name: string; size: number }[]; regions: { sets: string[]; count: number; members?: string[] }[] })
  | (Base<'hotspot'> & { box: [number, number, number, number]; spots: { x: number; y: number; label: string; detail: string; page?: number }[] });

type Obj = Record<string, unknown>;
class Invalid extends Error {}
const fail = (path: string, message: string): never => { throw new Invalid(`${path}: ${message}`); };
function obj(v: unknown, p: string): Obj { if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(p, '객체가 필요합니다'); return v as Obj; }
function str(v: unknown, p: string, max = 80): string { if (typeof v !== 'string') return fail(p, '문자열이 필요합니다'); return v.trim().slice(0, max); }
const CONTROL_ESCAPES: Record<string, string> = { '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
const restoreLatex = (v: unknown) => (typeof v === 'string' ? v.replace(/[\b\f\n\r\t]/g, (c) => CONTROL_ESCAPES[c]) : v);
function num(v: unknown, p: string): number { if (typeof v !== 'number' || !Number.isFinite(v)) return fail(p, '유한한 숫자가 필요합니다'); return v; }
function bool(v: unknown, p: string): boolean { if (typeof v !== 'boolean') return fail(p, '참 또는 거짓이 필요합니다'); return v; }
function arr(v: unknown, p: string, min: number, max: number): unknown[] { if (!Array.isArray(v) || v.length < min || v.length > max) return fail(p, `${min}~${max}개가 필요합니다`); return v; }
function optional<T>(v: unknown, fn: (v: unknown) => T): T | undefined { return v == null ? undefined : fn(v); }
function nullable(v: unknown, p: string): number | null { return v === null ? null : num(v, p); }
function strings(v: unknown, p: string, min: number, max: number): string[] { return arr(v, p, min, max).map((x, i) => str(x, `${p}[${i}]`)); }
function nums(v: unknown, p: string, length: number, nonnegative = false): number[] { const a = arr(v, p, 0, 2000); if (a.length !== length) return fail(p, '길이가 일치하지 않습니다'); return a.map((x, i) => { const n = num(x, `${p}[${i}]`); if (nonnegative && n < 0) fail(p, '음수는 허용되지 않습니다'); return n; }); }
function nullNums(v: unknown, p: string, length: number): (number | null)[] { const a = arr(v, p, 0, 2000); if (a.length !== length) return fail(p, '길이가 일치하지 않습니다'); return a.map((x, i) => nullable(x, `${p}[${i}]`)); }
function unique(values: string[], p: string): void { if (new Set(values).size !== values.length) fail(p, '중복된 값이 있습니다'); }
function finite(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }
function pointArray<T>(v: unknown, p: string, min: number, max: number, convert: (o: Obj, p: string) => T | null): T[] { const input = arr(v, p, 0, max); const result = input.map((x, i) => convert(obj(x, `${p}[${i}]`), `${p}[${i}]`)).filter((x): x is T => x !== null); if (result.length < min) fail(p, `유효한 항목이 ${min}개 이상 필요합니다`); return result; }
function page(v: unknown, count: number): number | undefined { return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= count ? v : undefined; }
function xy(o: Obj): XY | null { return finite(o.x) && finite(o.y) ? { x: o.x, y: o.y } : null; }
function ident(v: unknown, p: string): string { const s = str(v, p); if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) || s === 'pi' || s === 'e') fail(p, '올바른 변수 이름이 필요합니다'); return s; }
function checkExpression(src: string, path: string, allowed: Set<string>): void {
  let parsed: Expr;
  try { parsed = parseExpr(src); } catch (e) { return fail(path, e instanceof Error ? e.message : '수식이 올바르지 않습니다'); }
  for (const name of exprNames(parsed)) if (!allowed.has(name)) fail(path, `선언되지 않은 변수: ${name}`);
}

export function validateFigureSpec(raw: unknown, pageCount: number): { spec: FigureSpec } | { error: string } {
  try {
    const o = obj(raw, 'spec');
    if (!isFigureKind(o.kind)) return { error: `알 수 없는 kind: ${String(o.kind)}` };
    const k = o.kind;
    const base = { kind: k, title: str(o.title, 'title'), takeaway: str(o.takeaway, 'takeaway', 200), howTo: str(o.howTo, 'howTo', 160), approx: bool(o.approx, 'approx'), sources: arr(o.sources, 'sources', 0, 6).flatMap((v, i) => { const s = obj(v, `sources[${i}]`); const n = page(s.page, pageCount); if (n === undefined) return []; const quote = s.quote == null ? null : str(s.quote, `sources[${i}].quote`, 201); return [{ page: n, quote: quote !== null && quote.length <= 200 ? quote : null }]; }), notes: arr(o.notes, 'notes', 0, 5).map((v, i) => str(v, `notes[${i}]`, 200)) };
    const s = (v: unknown, p: string) => str(v, `${k}.${p}`);
    const list = (v: unknown, p: string, min: number, max: number) => arr(v, `${k}.${p}`, min, max);
    let extra: object;
    switch (k) {
      case 'line': extra = { xLabel: s(o.xLabel, 'xLabel'), yLabel: s(o.yLabel, 'yLabel'), xLog: optional(o.xLog, v => bool(v, 'line.xLog')), yLog: optional(o.yLog, v => bool(v, 'line.yLog')), series: list(o.series, 'series', 1, 12).map((v, i) => { const p = `line.series[${i}]`, a = obj(v, p); return { name: str(a.name, `${p}.name`), points: pointArray(a.points, `${p}.points`, 2, 500, (b, q) => { const pt = xy(b); if (!pt || (b.err != null && !finite(b.err))) return null; return { ...pt, err: optional(b.err, x => num(x, `${q}.err`)) }; }) }; }) }; break;
      case 'bar': { const categories = strings(o.categories, 'bar.categories', 1, 60); extra = { yLabel: s(o.yLabel, 'yLabel'), categories, series: list(o.series, 'series', 1, 12).map((v, i) => { const p = `bar.series[${i}]`, a = obj(v, p); return { name: str(a.name, `${p}.name`), values: nullNums(a.values, `${p}.values`, categories.length), errors: optional(a.errors, x => nullNums(x, `${p}.errors`, categories.length)) }; }) }; break; }
      case 'scatter': case 'ordination': extra = { xLabel: s(o.xLabel, 'xLabel'), yLabel: s(o.yLabel, 'yLabel'), ...(k === 'scatter' ? { xLog: optional(o.xLog, v => bool(v, `${k}.xLog`)), yLog: optional(o.yLog, v => bool(v, `${k}.yLog`)) } : {}), points: pointArray(o.points, `${k}.points`, 2, 2000, (a, p) => { const pt = xy(a); if (!pt) return null; return { ...pt, group: k === 'ordination' ? str(a.group, `${p}.group`) : optional(a.group, v => str(v, `${p}.group`)), label: optional(a.label, v => str(v, `${p}.label`)) }; }) }; break;
      case 'stacked': { const samples = strings(o.samples, 'stacked.samples', 1, 80); extra = { yLabel: s(o.yLabel, 'yLabel'), samples, parts: list(o.parts, 'parts', 1, 30).map((v, i) => { const p = `stacked.parts[${i}]`, a = obj(v, p); return { name: str(a.name, `${p}.name`), values: nums(a.values, `${p}.values`, samples.length) }; }) }; break; }
      case 'box': extra = { yLabel: s(o.yLabel, 'yLabel'), groups: list(o.groups, 'groups', 1, 30).map((v, i) => { const p = `box.groups[${i}]`, a = obj(v, p); const min = num(a.min, p), q1 = num(a.q1, p), median = num(a.median, p), q3 = num(a.q3, p), max = num(a.max, p); if (!(min <= q1 && q1 <= median && median <= q3 && q3 <= max)) fail(p, '사분위수 순서가 올바르지 않습니다'); return { name: str(a.name, `${p}.name`), min, q1, median, q3, max, mean: optional(a.mean, v => num(v, `${p}.mean`)), n: optional(a.n, v => num(v, `${p}.n`)) }; }) }; break;
      case 'heatmap': { const rows = strings(o.rows, 'heatmap.rows', 1, 80), cols = strings(o.cols, 'heatmap.cols', 1, 80); const values = list(o.values, 'values', rows.length, rows.length).map((v, i) => nullNums(v, `heatmap.values[${i}]`, cols.length)); extra = { rowLabel: s(o.rowLabel, 'rowLabel'), colLabel: s(o.colLabel, 'colLabel'), valueLabel: s(o.valueLabel, 'valueLabel'), rows, cols, values, diverging: bool(o.diverging, 'heatmap.diverging') }; break; }
      case 'histogram': {
        const series = list(o.series, 'series', 1, 6).map((v, i) => {
          const p = `histogram.series[${i}]`, a = obj(v, p);
          const bins = arr(a.bins, `${p}.bins`, 1, 200).map((v, j) => {
            const q = `${p}.bins[${j}]`, b = obj(v, q), x0 = num(b.x0, `${q}.x0`), x1 = num(b.x1, `${q}.x1`), count = num(b.count, `${q}.count`);
            if (x0 >= x1) fail(q, '구간 시작은 끝보다 작아야 합니다');
            if (count < 0) fail(q, '음수는 허용되지 않습니다');
            return { x0, x1, count };
          });
          if (bins.some((b, j) => j > 0 && b.x0 < bins[j - 1].x0)) fail(`${p}.bins`, '구간 순서가 올바르지 않습니다');
          return { name: str(a.name, `${p}.name`), bins };
        });
        extra = { xLabel: s(o.xLabel, 'xLabel'), yLabel: s(o.yLabel, 'yLabel'), series }; break;
      }
      case 'field': {
        const coordinates = (v: unknown, p: string) => {
          const a = arr(v, p, 2, 200).map((v, i) => num(v, `${p}[${i}]`));
          if (a.some((n, i) => i > 0 && n <= a[i - 1])) fail(p, '좌표는 증가해야 합니다');
          return a;
        };
        const x = coordinates(o.x, 'field.x'), y = coordinates(o.y, 'field.y');
        if (x.length * y.length > 10000) fail('field.values', '격자 칸은 10000개 이하여야 합니다');
        const values = list(o.values, 'values', y.length, y.length).map((v, i) => nullNums(v, `field.values[${i}]`, x.length));
        extra = { xLabel: s(o.xLabel, 'xLabel'), yLabel: s(o.yLabel, 'yLabel'), valueLabel: s(o.valueLabel, 'valueLabel'), x, y, values, diverging: bool(o.diverging, 'field.diverging') }; break;
      }
      case 'roc': {
        if (o.mode !== 'roc' && o.mode !== 'pr') fail('roc.mode', 'roc 또는 pr이 필요합니다');
        const unit = (v: unknown, p: string) => { const n = num(v, p); if (n < 0 || n > 1) fail(p, '0~1 범위여야 합니다'); return n; };
        const curves = list(o.curves, 'curves', 1, 8).map((v, i) => {
          const p = `roc.curves[${i}]`, a = obj(v, p);
          const points = arr(a.points, `${p}.points`, 2, 500).map((v, j) => {
            const q = `${p}.points[${j}]`, b = obj(v, q);
            return { x: unit(b.x, `${q}.x`), y: unit(b.y, `${q}.y`) };
          });
          return { name: str(a.name, `${p}.name`), points, auc: optional(a.auc, v => unit(v, `${p}.auc`)) };
        });
        extra = { mode: o.mode, curves }; break;
      }
      case 'volcano': { const pThreshold = num(o.pThreshold, 'volcano.pThreshold'), fcThreshold = num(o.fcThreshold, 'volcano.fcThreshold'); if (pThreshold < 0 || pThreshold > 1 || fcThreshold < 0) fail('volcano', '기준값이 범위를 벗어났습니다'); extra = { xLabel: s(o.xLabel, 'xLabel'), pThreshold, fcThreshold, points: pointArray(o.points, 'volcano.points', 1, 2000, (a, p) => { if (!finite(a.log2fc) || !finite(a.p)) return null; if (a.p <= 0 || a.p > 1) fail(p, 'p는 0보다 크고 1 이하여야 합니다'); return { log2fc: a.log2fc, p: a.p, label: optional(a.label, v => str(v, `${p}.label`)) }; }) }; break; }
      case 'survival': extra = { timeLabel: s(o.timeLabel, 'timeLabel'), yLabel: optional(o.yLabel, v => str(v, 'survival.yLabel')), groups: list(o.groups, 'groups', 1, 8).map((v, i) => { const p = `survival.groups[${i}]`, a = obj(v, p); const steps = pointArray(a.steps, `${p}.steps`, 1, 2000, (b, q) => { if (!finite(b.t) || !finite(b.s)) return null; if (b.s < 0 || b.s > 1) fail(q, '생존율이 범위를 벗어났습니다'); return { t: b.t, s: b.s }; }); if (steps.some((x, j) => j > 0 && x.t < steps[j - 1].t)) fail(p, '시간 순서가 올바르지 않습니다'); return { name: str(a.name, `${p}.name`), steps, censored: optional(a.censored, v => arr(v, `${p}.censored`, 0, 2000).filter(finite)) }; }) }; break;
      case 'doseResponse': extra = { xLabel: s(o.xLabel, 'xLabel'), yLabel: s(o.yLabel, 'yLabel'), curves: list(o.curves, 'curves', 1, 8).map((v, i) => { const p = `doseResponse.curves[${i}]`, a = obj(v, p), ec50 = num(a.ec50, `${p}.ec50`), hill = num(a.hill, `${p}.hill`); if (ec50 <= 0 || hill === 0) fail(p, 'ec50 또는 hill이 올바르지 않습니다'); return { name: str(a.name, `${p}.name`), bottom: num(a.bottom, p), top: num(a.top, p), ec50, hill, points: optional(a.points, v => pointArray(v, `${p}.points`, 0, 2000, (b, q) => { const pt = xy(b); if (!pt) return null; if (pt.x <= 0) fail(q, 'x는 양수여야 합니다'); return pt; })) }; }) }; break;
      case 'formula': {
        const expression = str(o.expression, 'formula.expression', 301);
        const a = obj(o.x, 'formula.x');
        const x = { name: ident(a.name, 'formula.x.name'), label: str(a.label, 'formula.x.label'), min: num(a.min, 'formula.x.min'), max: num(a.max, 'formula.x.max') };
        if (x.min >= x.max) fail('formula.x', '최솟값은 최댓값보다 작아야 합니다');
        const variables = list(o.variables, 'variables', 0, 8).map((v, i) => { const p = `formula.variables[${i}]`, b = obj(v, p); const min = num(b.min, p), max = num(b.max, p), step = num(b.step, p), value = num(b.value, p); if (min >= max || step <= 0 || value < min || value > max) fail(p, '변수 범위가 올바르지 않습니다'); return { name: ident(b.name, `${p}.name`), label: str(b.label, `${p}.label`), min, max, step, value, unit: optional(b.unit, v => str(v, `${p}.unit`)) }; });
        unique([x.name, ...variables.map(v => v.name)], 'formula.variables');
        const allowed = new Set([x.name, ...variables.map(v => v.name), 'pi', 'e']);
        checkExpression(expression, 'formula.expression', allowed);
        const xLog = optional(o.xLog, v => bool(v, 'formula.xLog')), yLog = optional(o.yLog, v => bool(v, 'formula.yLog'));
        if (xLog && x.min <= 0) fail('formula.xLog', '로그 x축은 x.min이 0보다 커야 합니다');
        const yMin = optional(o.yMin, v => num(v, 'formula.yMin')), yMax = optional(o.yMax, v => num(v, 'formula.yMax'));
        if ((yMin === undefined) !== (yMax === undefined) || (yMin !== undefined && yMax !== undefined && yMin >= yMax)) fail('formula', 'yMin과 yMax는 함께 쓰고 yMin < yMax여야 합니다');
        const compare = optional(o.compare, v => arr(v, 'formula.compare', 0, 4).map((v, i) => {
          const p = `formula.compare[${i}]`, b = obj(v, p), expression = str(b.expression, `${p}.expression`, 301);
          checkExpression(expression, `${p}.expression`, allowed);
          return { name: str(b.name, `${p}.name`, 40), expression };
        }));
        extra = { expression, latex: str(restoreLatex(o.latex), 'formula.latex', 300), x, yLabel: s(o.yLabel, 'yLabel'), variables, xLog, yLog, yMin, yMax, compare }; break;
      }
      case 'compare': { const conditions = strings(o.conditions, 'compare.conditions', 2, 6); extra = { conditions, metrics: list(o.metrics, 'metrics', 1, 20).map((v, i) => { const p = `compare.metrics[${i}]`, a = obj(v, p); return { name: str(a.name, `${p}.name`), unit: optional(a.unit, v => str(v, `${p}.unit`)), values: nullNums(a.values, `${p}.values`, conditions.length), higherIsBetter: optional(a.higherIsBetter, v => bool(v, `${p}.higherIsBetter`)) }; }) }; break; }
      case 'table': { const columns = list(o.columns, 'columns', 1, 12).map((v, i) => { const p = `table.columns[${i}]`, a = obj(v, p); return { key: str(a.key, `${p}.key`), label: str(a.label, `${p}.label`), numeric: bool(a.numeric, `${p}.numeric`), unit: optional(a.unit, v => str(v, `${p}.unit`)) }; }); unique(columns.map(x => x.key), 'table.columns'); const rows = list(o.rows, 'rows', 1, 200).map((v, i) => { const a = obj(v, `table.rows[${i}]`); const row: Record<string, string | number | null> = Object.create(null); for (const c of columns) { const value = a[c.key]; if (value === null) row[c.key] = null; else if (typeof value === 'string') row[c.key] = str(value, `table.rows[${i}].${c.key}`, 300); else row[c.key] = num(value, `table.rows[${i}].${c.key}`); } return row; }); const highlight = optional(o.highlight, v => arr(v, 'table.highlight', 0, 200).map(x => { const n = num(x, 'table.highlight'); if (!Number.isInteger(n) || n < 0 || n >= rows.length) fail('table.highlight', '행 번호가 올바르지 않습니다'); return n; })); extra = { columns, rows, highlight }; break; }
      case 'flow': { const steps = list(o.steps, 'steps', 2, 30).map((v, i) => { const p = `flow.steps[${i}]`, a = obj(v, p); return { id: str(a.id, `${p}.id`), label: str(a.label, `${p}.label`), detail: str(a.detail, `${p}.detail`, 300), page: page(a.page, pageCount) }; }); unique(steps.map(x => x.id), 'flow.steps'); const ids = new Set(steps.map(x => x.id)); const edges = list(o.edges, 'edges', 0, 900).map((v, i) => { const p = `flow.edges[${i}]`, a = obj(v, p), from = str(a.from, `${p}.from`), to = str(a.to, `${p}.to`); if (!ids.has(from) || !ids.has(to)) fail(p, '존재하지 않는 단계입니다'); return { from, to, label: optional(a.label, v => str(v, `${p}.label`)) }; }); extra = { steps, edges }; break; }
      case 'timeline': extra = { unit: s(o.unit, 'unit'), events: list(o.events, 'events', 1, 60).map((v, i) => { const p = `timeline.events[${i}]`, a = obj(v, p), start = num(a.start, `${p}.start`), end = optional(a.end, v => num(v, `${p}.end`)); if (end !== undefined && end < start) fail(p, '끝이 시작보다 빠릅니다'); return { label: str(a.label, `${p}.label`), detail: str(a.detail, `${p}.detail`, 300), start, end, lane: optional(a.lane, v => str(v, `${p}.lane`)) }; }) }; break;
      case 'tree': { let count = 0; const node = (v: unknown, depth: number): FigureTreeNode => { if (depth > 6 || ++count > 200) fail('tree.root', '트리의 깊이 또는 노드 수가 너무 큽니다'); const a = obj(v, 'tree.root'); return { label: str(a.label, 'tree.label'), detail: optional(a.detail, v => str(v, 'tree.detail', 300)), children: optional(a.children, v => arr(v, 'tree.children', 0, 200).map(x => node(x, depth + 1))) }; }; extra = { root: node(o.root, 1) }; break; }
      case 'network': { const nodes = list(o.nodes, 'nodes', 2, 150).map((v, i) => { const p = `network.nodes[${i}]`, a = obj(v, p); return { id: str(a.id, `${p}.id`), label: str(a.label, `${p}.label`), group: optional(a.group, v => str(v, `${p}.group`)), detail: optional(a.detail, v => str(v, `${p}.detail`, 300)) }; }); unique(nodes.map(x => x.id), 'network.nodes'); const ids = new Set(nodes.map(x => x.id)); const edges = list(o.edges, 'edges', 0, 600).map((v, i) => { const p = `network.edges[${i}]`, a = obj(v, p), source = str(a.source, `${p}.source`), target = str(a.target, `${p}.target`); if (!ids.has(source) || !ids.has(target)) fail(p, '존재하지 않는 노드입니다'); if (a.sign != null && a.sign !== '+' && a.sign !== '-') fail(p, '부호가 올바르지 않습니다'); return { source, target, weight: optional(a.weight, v => num(v, `${p}.weight`)), sign: a.sign }; }); extra = { nodes, edges }; break; }
      case 'venn': { const sets = list(o.sets, 'sets', 2, 3).map((v, i) => { const p = `venn.sets[${i}]`, a = obj(v, p); const size = num(a.size, `${p}.size`); if (size < 0) fail(p, '크기는 음수일 수 없습니다'); return { name: str(a.name, `${p}.name`), size }; }); unique(sets.map(x => x.name), 'venn.sets'); const names = new Set(sets.map(x => x.name)); const regions = list(o.regions, 'regions', 0, 7).map((v, i) => { const p = `venn.regions[${i}]`, a = obj(v, p), members = strings(a.sets, `${p}.sets`, 1, sets.length), count = num(a.count, `${p}.count`); unique(members, `${p}.sets`); if (members.some(x => !names.has(x)) || count < 0) fail(p, '영역이 올바르지 않습니다'); return { sets: members, count, members: optional(a.members, v => strings(v, `${p}.members`, 0, 50)) }; }); extra = { sets, regions }; break; }
      case 'hotspot': { const b = arr(o.box, 'hotspot.box', 4, 4).map(v => num(v, 'hotspot.box')); if (b.some(x => x < 0 || x > 1) || b[0] >= b[2] || b[1] >= b[3]) fail('hotspot.box', '영역이 올바르지 않습니다'); extra = { box: b, spots: pointArray(o.spots, 'hotspot.spots', 1, 20, (a, p) => { const pt = xy(a); if (!pt) return null; if (pt.x < 0 || pt.x > 1 || pt.y < 0 || pt.y > 1) fail(p, '좌표가 범위를 벗어났습니다'); return { ...pt, label: str(a.label, `${p}.label`), detail: str(a.detail, `${p}.detail`, 300), page: page(a.page, pageCount) }; }) }; break; }
    }
    return { spec: { ...base, ...extra } as FigureSpec };
  } catch (e) { if (e instanceof Invalid) return { error: e.message }; throw e; }
}
