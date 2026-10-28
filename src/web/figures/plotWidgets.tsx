import { useState } from 'react';
import * as Plot from '@observablehq/plot';
import type { FigureSpec } from '../../shared/figure-spec';
import { PlotFrame } from './PlotFrame';
import { Switch, ToggleChips } from './controls';
import { logReason, useValidLog, formatNumber } from './scales';

type Spec<K extends FigureSpec['kind']> = Extract<FigureSpec, { kind: K }>;
function useSelection(items: string[]) {
  const [active, setActive] = useState(() => new Set(items));
  const toggle = (item: string) => setActive(previous => { const next = new Set(previous); if (next.has(item)) next.delete(item); else next.add(item); return next; });
  return { active, toggle };
}
const controls = 'flex flex-wrap items-center gap-3';
const selectClass = 'rounded border border-line bg-surface px-2 py-1 text-xs text-fg';


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
  const hasNegative = data.some(d => d.value < 0);
  const normalized = normalize && !hasNegative;
  const part = spec.parts.find(p => p.name === sort);
  const samples = part ? spec.samples.map((name, i) => ({ name, value: part.values[i] })).sort((a, b) => b.value - a.value).map(x => x.name) : spec.samples;
  return <div className="space-y-2"><ToggleChips items={names} active={active} onToggle={toggle} /><div className={controls}><Switch label="100%로 보기" checked={normalized} onChange={setNormalize} disabled={hasNegative} description={hasNegative ? '음수 값이 있어 100%로 볼 수 없습니다.' : undefined} /><label className="text-xs text-fg-muted">정렬 기준 <select className={selectClass} value={sort} onChange={e => setSort(e.target.value)}><option value="">원래 순서</option>{names.map(n => <option key={n} value={n}>{n}</option>)}</select></label></div><PlotFrame options={{ x: { domain: samples, label: null }, y: { label: normalized ? `${spec.yLabel} (%)` : spec.yLabel, ...(normalized ? { tickFormat: '%' } : {}) }, color: { domain: names, legend: true }, marks: [Plot.barY(data, Plot.stackY({ x: 'sample', y: 'value', fill: 'part', ...(normalized ? { offset: 'normalize' as const } : {}), title: (d: typeof data[number]) => `${d.sample} · ${d.part}: ${d.value}`, tip: true }))] }} /></div>;
}

export function HistogramWidget({ spec }: { spec: Spec<'histogram'> }) {
  const names = spec.series.map(s => s.name), { active, toggle } = useSelection(names);
  const [density, setDensity] = useState(false);
  const data = spec.series.filter(s => active.has(s.name)).flatMap(s => {
    const total = s.bins.reduce((sum, bin) => sum + bin.count, 0);
    return s.bins.map(bin => ({ ...bin, series: s.name, y: density ? (total ? bin.count / (total * (bin.x1 - bin.x0)) : 0) : bin.count }));
  });
  const reason = logReason(data.map(d => d.y));
  const [logY, setLogY] = useValidLog(false, reason);
  const baseline = logY ? Math.min(...data.map(d => d.y)) / 2 : 0;
  return <div className="space-y-2">
    <ToggleChips items={names} active={active} onToggle={toggle} />
    <div className={controls}><Switch label="밀도로 보기" checked={density} onChange={setDensity} /><Switch label="로그 Y" checked={logY} onChange={setLogY} disabled={!!reason} description={reason} /></div>
    <PlotFrame options={{ x: { label: spec.xLabel }, y: { label: `${spec.yLabel}${density ? ' (밀도)' : ''}`, type: logY ? 'log' : 'linear' }, color: { domain: names }, marks: [
      Plot.rectY(data, { x1: 'x0', x2: 'x1', y1: baseline, y2: 'y', fill: 'series', fillOpacity: active.size > 1 ? 0.55 : 0.85, insetLeft: 0.5, insetRight: 0.5 }),
      Plot.tip(data, Plot.pointerX({ x: (d: typeof data[number]) => (d.x0 + d.x1) / 2, y: 'y', title: (d: typeof data[number]) => `${d.series}: ${formatNumber(d.x0)}–${formatNumber(d.x1)} · ${formatNumber(d.y)}` })),
    ] }} />
  </div>;
}

/** Plot.contour closes filled regions along the grid edge; keep only interior isolines. */
function isolineRender(x0: number, x1: number, y0: number, y1: number): Plot.RenderFunction {
  return (index, scales, values, dimensions, context, next) => {
    const group = next?.(index, scales, values, dimensions, context) ?? null;
    if (!group || !scales.x || !scales.y || !values.geometry) return group;
    const xs = [scales.x(x0), scales.x(x1)], ys = [scales.y(y0), scales.y(y1)];
    const left = Math.min(...xs) - 1e-6, right = Math.max(...xs) + 1e-6;
    const top = Math.min(...ys) - 1e-6, bottom = Math.max(...ys) + 1e-6;
    const paths = group.querySelectorAll('path');
    index.forEach((id, i) => {
      const geometry = values.geometry![id] as { coordinates: [number, number][][][] };
      const segments: string[] = [];
      for (const polygon of geometry.coordinates) for (const ring of polygon) {
        let segment: [number, number][] = [];
        const flush = () => {
          if (segment.length > 1) segments.push(segment.map(([x, y], j) => `${j ? 'L' : 'M'}${x},${y}`).join(''));
          segment = [];
        };
        for (const point of ring) {
          if (point[0] >= left && point[0] <= right && point[1] >= top && point[1] <= bottom) segment.push(point);
          else flush();
        }
        flush();
      }
      if (segments.length) paths[i]?.setAttribute('d', segments.join(''));
      else paths[i]?.remove();
    });
    return group;
  };
}

export function FieldWidget({ spec }: { spec: Spec<'field'> }) {
  const schemes = ['viridis', 'magma', 'turbo', 'ylgnbu'] as const;
  const [scheme, setScheme] = useState<(typeof schemes)[number]>('viridis'), [contours, setContours] = useState(false);
  const edges = (coords: number[]) => coords.map((value, i) => [
    i === 0 ? value - (coords[1] - value) / 2 : (coords[i - 1] + value) / 2,
    i === coords.length - 1 ? value + (value - coords[i - 1]) / 2 : (value + coords[i + 1]) / 2,
  ]);
  const xe = edges(spec.x), ye = edges(spec.y);
  const cells = spec.values.flatMap((row, i) => row.flatMap((value, j) => value === null ? [] : [{ x: spec.x[j], y: spec.y[i], x1: xe[j][0], x2: xe[j][1], y1: ye[i][0], y2: ye[i][1], value }]));
  const reason = spec.diverging ? '발산 색상표에서는 로그 색을 쓸 수 없습니다.' : logReason(cells.map(d => d.value));
  const [logColor, setLogColor] = useValidLog(false, reason);
  const uniform = (coords: number[]) => {
    const step = coords[1] - coords[0];
    return coords.slice(2).every((value, i) => Math.abs((value - coords[i + 1]) - step) <= step * 0.01);
  };
  const regular = uniform(spec.x) && uniform(spec.y);
  const dx = spec.x[1] - spec.x[0], dy = spec.y[1] - spec.y[0];
  const flat = spec.values.flatMap(row => row.map(value => value ?? NaN));
  return <div className="space-y-2">
    <div className={controls}>
      <label className="text-xs text-fg-muted">색상표 <select className={selectClass} value={scheme} onChange={e => setScheme(e.target.value as (typeof schemes)[number])} disabled={spec.diverging}>{schemes.map(s => <option key={s} value={s}>{s}</option>)}</select></label>
      <Switch label="로그 색" checked={logColor} onChange={setLogColor} disabled={!!reason} description={reason} />
      <Switch label="등고선" checked={contours && regular} onChange={setContours} disabled={!regular} description={!regular ? '격자 간격이 고르지 않아 등고선을 그릴 수 없습니다.' : undefined} />
    </div>
    <PlotFrame options={{ height: 360, x: { label: spec.xLabel }, y: { label: spec.yLabel }, color: spec.diverging ? { type: 'diverging', scheme: 'rdbu', reverse: true, pivot: 0, legend: true, label: spec.valueLabel } : { type: logColor ? 'log' : 'linear', scheme, legend: true, label: spec.valueLabel }, marks: [
      Plot.rect(cells, { x1: 'x1', x2: 'x2', y1: 'y1', y2: 'y2', fill: 'value' }),
      contours && regular ? Plot.contour(flat, { x1: spec.x[0] - dx / 2, x2: spec.x[spec.x.length - 1] + dx / 2, y1: spec.y[0] - dy / 2, y2: spec.y[spec.y.length - 1] + dy / 2, width: spec.x.length, height: spec.y.length, thresholds: 10, stroke: 'currentColor', strokeOpacity: 0.6, fill: 'none', render: isolineRender(spec.x[0], spec.x[spec.x.length - 1], spec.y[0], spec.y[spec.y.length - 1]) }) : null,
      Plot.tip(cells, Plot.pointer({ x: 'x', y: 'y', title: (d: typeof cells[number]) => `${spec.xLabel}: ${formatNumber(d.x)} · ${spec.yLabel}: ${formatNumber(d.y)} · ${spec.valueLabel}: ${formatNumber(d.value)}` })),
    ] }} />
  </div>;
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
