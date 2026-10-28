import { useEffect, useState } from 'react';
import * as Plot from '@observablehq/plot';
import type { FigureSpec } from '../../shared/figure-spec';
import { PlotFrame } from './PlotFrame';
import { Switch, ToggleChips } from './controls';

type Spec<K extends FigureSpec['kind']> = Extract<FigureSpec, { kind: K }>;
function useSelection(items: string[]) {
  const [active, setActive] = useState(() => new Set(items));
  const toggle = (item: string) => setActive(previous => { const next = new Set(previous); if (next.has(item)) next.delete(item); else next.add(item); return next; });
  return { active, toggle };
}
const controls = 'flex flex-wrap items-center gap-3';
const selectClass = 'rounded border border-line bg-surface px-2 py-1 text-xs text-fg';

function logReason(values: number[], extents: number[] = []): string | undefined {
  if (!values.length) return '표시된 데이터가 없습니다.';
  if (values.some(value => !Number.isFinite(value) || value <= 0)) return '0 이하 또는 유효하지 않은 값이 있습니다.';
  if (extents.some(value => !Number.isFinite(value) || value <= 0)) return '오차 범위가 0 이하이거나 유효하지 않습니다.';
  return undefined;
}

function useValidLog(initial: boolean, reason: string | undefined) {
  const [requested, setRequested] = useState(initial && !reason);
  useEffect(() => { if (reason) setRequested(false); }, [reason]);
  return [requested && !reason, setRequested] as const;
}

export function LineWidget({ spec }: { spec: Spec<'line'> }) {
  const names = spec.series.map(s => s.name);
  const { active, toggle } = useSelection(names);
  const all = spec.series.flatMap(s => s.points);
  const [errors, setErrors] = useState(true);
  const data = spec.series.filter(s => active.has(s.name)).flatMap(s => s.points.map(p => ({ ...p, series: s.name })));
  const err = data.filter(p => p.err !== undefined).map(p => ({ ...p, low: p.y - Math.abs(p.err!), high: p.y + Math.abs(p.err!) }));
  const xReason = logReason(data.map(p => p.x));
  const yReason = logReason(data.map(p => p.y), errors ? err.flatMap(p => [p.low, p.high]) : []);
  const [logX, setLogX] = useValidLog(!!spec.xLog, xReason), [logY, setLogY] = useValidLog(!!spec.yLog, yReason);
  return <div className="space-y-2"><ToggleChips items={names} active={active} onToggle={toggle} /><div className={controls}><Switch label="로그 X" checked={logX} onChange={setLogX} disabled={!!xReason} description={xReason} /><Switch label="로그 Y" checked={logY} onChange={setLogY} disabled={!!yReason} description={yReason} />{all.some(p => p.err !== undefined) && <Switch label="오차 막대" checked={errors} onChange={setErrors} />}</div><PlotFrame options={{ x: { label: spec.xLabel, type: logX ? 'log' : 'linear' }, y: { label: spec.yLabel, type: logY ? 'log' : 'linear' }, color: { domain: names }, marks: [Plot.line(data, { x: 'x', y: 'y', stroke: 'series' }), errors ? Plot.ruleX(err, { x: 'x', y1: 'low', y2: 'high', stroke: 'series' }) : null, Plot.dot(data, { x: 'x', y: 'y', fill: 'series', r: 3 }), Plot.tip(data, Plot.pointer({ x: 'x', y: 'y', title: (d: typeof data[number]) => `${d.series}\n${spec.xLabel}: ${d.x}\n${spec.yLabel}: ${d.y}${d.err === undefined ? '' : ` ± ${d.err}`}` }))] }} /></div>;
}

export function BarWidget({ spec }: { spec: Spec<'bar'> }) {
  const names = spec.series.map(s => s.name), { active, toggle } = useSelection(names);
  const [sort, setSort] = useState(false);
  const all = spec.series.flatMap(s => s.values.flatMap((value, i) => value === null ? [] : [{ category: spec.categories[i], series: s.name, value, error: s.errors?.[i] ?? null }]));
  const data = all.filter(d => active.has(d.series));
  const err = data.filter(d => d.error !== null).map(d => ({ ...d, low: d.value - Math.abs(d.error!), high: d.value + Math.abs(d.error!) }));
  const reason = logReason(data.map(d => d.value), err.flatMap(d => [d.low, d.high]));
  const [log, setLog] = useValidLog(false, reason);
  const totals = new Map(spec.categories.map(c => [c, data.filter(d => d.category === c).reduce((n, d) => n + d.value, 0)]));
  const categories = sort ? [...spec.categories].sort((a, b) => totals.get(b)! - totals.get(a)!) : spec.categories;
  const minimum = reason ? 0 : Math.min(...data.map(d => d.value), ...err.map(d => d.low));
  const baseline = minimum / 2 || minimum;
  return <div className="space-y-2"><ToggleChips items={names} active={active} onToggle={toggle} /><div className={controls}><Switch label="값 순 정렬" checked={sort} onChange={setSort} /><Switch label="로그 Y" checked={log} onChange={setLog} disabled={!!reason} description={reason} /></div><PlotFrame options={{ fx: { domain: categories, label: null }, x: { domain: names, label: null, axis: null }, y: { label: spec.yLabel, type: log ? 'log' : 'linear' }, color: { domain: names }, marks: [Plot.barY(data, { fx: 'category', x: 'series', y1: log ? baseline : 0, y2: 'value', fill: 'series' }), Plot.ruleX(err, { fx: 'category', x: 'series', y1: 'low', y2: 'high', stroke: 'currentColor' }), Plot.tip(data, Plot.pointer({ fx: 'category', x: 'series', y: 'value', title: (d: typeof data[number]) => `${d.category} · ${d.series}\n${d.value}${d.error === null ? '' : ` ± ${d.error}`}` }))] }} /></div>;
}

export function ScatterWidget({ spec }: { spec: Spec<'scatter'> }) {
  const names = [...new Set(spec.points.map(p => p.group ?? '기타'))], { active, toggle } = useSelection(names);
  const [trend, setTrend] = useState(false);
  const data = spec.points.map(p => ({ ...p, group: p.group ?? '기타' })).filter(p => active.has(p.group));
  const xReason = logReason(data.map(p => p.x)), yReason = logReason(data.map(p => p.y));
  const [logX, setLogX] = useValidLog(!!spec.xLog, xReason), [logY, setLogY] = useValidLog(!!spec.yLog, yReason);
  return <div className="space-y-2"><ToggleChips items={names} active={active} onToggle={toggle} /><div className={controls}><Switch label="추세선" checked={trend} onChange={setTrend} /><Switch label="로그 X" checked={logX} onChange={setLogX} disabled={!!xReason} description={xReason} /><Switch label="로그 Y" checked={logY} onChange={setLogY} disabled={!!yReason} description={yReason} /></div><PlotFrame options={{ x: { label: spec.xLabel, type: logX ? 'log' : 'linear' }, y: { label: spec.yLabel, type: logY ? 'log' : 'linear' }, color: { domain: names }, marks: [trend ? Plot.linearRegressionY(data, { x: 'x', y: 'y', stroke: 'group' }) : null, Plot.dot(data, { x: 'x', y: 'y', fill: 'group' }), Plot.tip(data, Plot.pointer({ x: 'x', y: 'y', title: (d: typeof data[number]) => `${d.label ? `${d.label}\n` : ''}${d.group}\n${spec.xLabel}: ${d.x}\n${spec.yLabel}: ${d.y}` }))] }} /></div>;
}

export function StackedWidget({ spec }: { spec: Spec<'stacked'> }) {
  const names = spec.parts.map(p => p.name), { active, toggle } = useSelection(names);
  const [normalize, setNormalize] = useState(false), [sort, setSort] = useState('');
  const data = spec.parts.filter(p => active.has(p.name)).flatMap(p => p.values.map((value, i) => ({ sample: spec.samples[i], part: p.name, value })));
  const part = spec.parts.find(p => p.name === sort);
  const samples = part ? spec.samples.map((name, i) => ({ name, value: part.values[i] })).sort((a, b) => b.value - a.value).map(x => x.name) : spec.samples;
  return <div className="space-y-2"><ToggleChips items={names} active={active} onToggle={toggle} /><div className={controls}><Switch label="100%로 보기" checked={normalize} onChange={setNormalize} /><label className="text-xs text-fg-muted">정렬 기준 <select className={selectClass} value={sort} onChange={e => setSort(e.target.value)}><option value="">원래 순서</option>{names.map(n => <option key={n} value={n}>{n}</option>)}</select></label></div><PlotFrame options={{ x: { domain: samples, label: null }, y: { label: normalize ? `${spec.yLabel} (%)` : spec.yLabel, ...(normalize ? { tickFormat: '%' } : {}) }, color: { domain: names, legend: true }, marks: [Plot.barY(data, Plot.stackY({ x: 'sample', y: 'value', fill: 'part', ...(normalize ? { offset: 'normalize' as const } : {}), title: (d: typeof data[number]) => `${d.sample} · ${d.part}: ${d.value}`, tip: true }))] }} /></div>;
}

export function BoxWidget({ spec }: { spec: Spec<'box'> }) {
  const [mean, setMean] = useState(false);
  const means = spec.groups.filter(g => g.mean !== undefined);
  return <div className="space-y-2"><Switch label="평균 표시" checked={mean} onChange={setMean} disabled={!means.length} description={!means.length ? '제공된 평균값이 없습니다.' : means.length < spec.groups.length ? `${spec.groups.length}개 그룹 중 ${means.length}개의 평균만 제공됩니다.` : undefined} /><PlotFrame options={{ x: { label: null, domain: spec.groups.map(g => g.name) }, y: { label: spec.yLabel }, marks: [Plot.ruleX(spec.groups, { x: 'name', y1: 'min', y2: 'max' }), Plot.barY(spec.groups, { x: 'name', y1: 'q1', y2: 'q3', fill: 'var(--pr-accent)', fillOpacity: 0.4, inset: 8 }), Plot.tickY(spec.groups, { x: 'name', y: 'median', stroke: 'currentColor', strokeWidth: 2, inset: 8 }), mean ? Plot.dot(means, { x: 'name', y: 'mean', fill: 'currentColor' }) : null, Plot.tip(spec.groups, Plot.pointer({ x: 'name', y: 'median', title: (d: typeof spec.groups[number]) => `${d.name}\n최소: ${d.min}\nQ1: ${d.q1}\n중앙값: ${d.median}\nQ3: ${d.q3}\n최대: ${d.max}${d.mean === undefined ? '' : `\n평균: ${d.mean}`}${d.n === undefined ? '' : `\nn: ${d.n}`}` }))] }} /></div>;
}

export function HeatmapWidget({ spec }: { spec: Spec<'heatmap'> }) {
  const [rowSort, setRowSort] = useState(''), [colSort, setColSort] = useState('');
  const compare = (a: number | null, b: number | null) => a === null ? (b === null ? 0 : 1) : b === null ? -1 : b - a;
  const colIndex = rowSort === '' ? -1 : Number(rowSort), rowIndex = colSort === '' ? -1 : Number(colSort);
  const rows = spec.rows.map((name, i) => ({ name, i })).sort((a, b) => colIndex < 0 ? a.i - b.i : compare(spec.values[a.i][colIndex], spec.values[b.i][colIndex]));
  const cols = spec.cols.map((name, i) => ({ name, i })).sort((a, b) => rowIndex < 0 ? a.i - b.i : compare(spec.values[rowIndex][a.i], spec.values[rowIndex][b.i]));
  const data = spec.values.flatMap((row, i) => row.flatMap((value, j) => value === null ? [] : [{ row: spec.rows[i], col: spec.cols[j], value }]));
  return <div className="space-y-2"><div className={controls}><label className="text-xs text-fg-muted">행 정렬 <select className={selectClass} value={rowSort} onChange={e => setRowSort(e.target.value)}><option value="">원래 순서</option>{spec.cols.map((c, i) => <option key={i} value={i}>{c}</option>)}</select></label><label className="text-xs text-fg-muted">열 정렬 <select className={selectClass} value={colSort} onChange={e => setColSort(e.target.value)}><option value="">원래 순서</option>{spec.rows.map((r, i) => <option key={i} value={i}>{r}</option>)}</select></label></div><PlotFrame options={{ height: Math.max(240, Math.min(1400, spec.rows.length * 22 + 80)), x: { label: spec.colLabel, domain: cols.map(c => c.name) }, y: { label: spec.rowLabel, domain: rows.map(r => r.name) }, color: spec.diverging ? { type: 'diverging', scheme: 'rdbu', reverse: true, pivot: 0, legend: true, label: spec.valueLabel } : { type: 'linear', scheme: 'ylgnbu', legend: true, label: spec.valueLabel }, marks: [Plot.cell(data, { x: 'col', y: 'row', fill: 'value', inset: 0.5, title: d => `${d.row} · ${d.col}\n${spec.valueLabel}: ${d.value}`, tip: true })] }} /></div>;
}
