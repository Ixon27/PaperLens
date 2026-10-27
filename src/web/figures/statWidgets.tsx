import { useMemo, useState } from 'react';
import * as Plot from '@observablehq/plot';
import type { FigureSpec } from '../../shared/figure-spec';
import { evalExpr, parseExpr } from '../../shared/expr';
import { Markdown } from '../components/Markdown';
import { smallGhostBtnCls } from '../components/Dialog';
import { PlotFrame } from './PlotFrame';
import { RangeSlider, Switch, ToggleChips } from './controls';

type Spec<K extends FigureSpec['kind']> = Extract<FigureSpec, { kind: K }>;

function useVisible(names: string[]) {
  const [active, setActive] = useState(() => new Set(names));
  const toggle = (name: string) => setActive(previous => {
    const next = new Set(previous);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  return { active, toggle };
}

const format = (n: number) => Number(n.toPrecision(4)).toString();

export function VolcanoWidget({ spec }: { spec: Spec<'volcano'> }) {
  const [logP, setLogP] = useState(() => Math.max(-10, Math.min(-1, Math.log10(spec.pThreshold || 1e-10))));
  const [fc, setFc] = useState(() => Math.min(5, spec.fcThreshold));
  const p = 10 ** logP;
  const points = spec.points.map(point => ({ ...point, y: -Math.log10(point.p), category: point.p <= p && point.log2fc >= fc ? 'up' : point.p <= p && point.log2fc <= -fc ? 'down' : 'ns' }));
  const up = points.filter(point => point.category === 'up').length;
  const down = points.filter(point => point.category === 'down').length;
  const labels = points.filter(point => point.category !== 'ns' && point.label).sort((a, b) => a.p - b.p).slice(0, 10);
  return <div className="space-y-2">
    <RangeSlider label={`p 기준 (${p.toExponential(1)})`} value={logP} min={-10} max={-1} step={0.1} onChange={setLogP} />
    <RangeSlider label="|log2FC| 기준" value={fc} min={0} max={5} step={0.1} onChange={setFc} />
    <p className="text-xs text-fg-dim">증가 {up} · 감소 {down}</p>
    <PlotFrame options={{ x: { label: spec.xLabel }, y: { label: '−log10(p)' }, color: { domain: ['up', 'down', 'ns'], range: ['var(--pr-danger)', 'var(--pr-accent)', 'var(--pr-fg-dim)'] }, marks: [
      Plot.ruleX([-fc, fc], { stroke: 'currentColor', strokeOpacity: 0.45, strokeDasharray: '4,4' }),
      Plot.ruleY([-logP], { stroke: 'currentColor', strokeOpacity: 0.45, strokeDasharray: '4,4' }),
      Plot.dot(points, { x: 'log2fc', y: 'y', fill: 'category', r: 3 }),
      Plot.text(labels, { x: 'log2fc', y: 'y', text: 'label', dy: -8, fontSize: 10 }),
      Plot.tip(points, Plot.pointer({ x: 'log2fc', y: 'y', title: (d: typeof points[number]) => `${d.label || '점'}\nlog2FC: ${format(d.log2fc)}\np: ${d.p.toExponential(2)}` })),
    ] }} />
  </div>;
}

export function OrdinationWidget({ spec }: { spec: Spec<'ordination'> }) {
  const names = [...new Set(spec.points.map(point => point.group))];
  const { active, toggle } = useVisible(names);
  const [centers, setCenters] = useState(false);
  const [labels, setLabels] = useState(false);
  const points = spec.points.filter(point => active.has(point.group));
  const means = names.filter(name => active.has(name)).map(group => {
    const members = points.filter(point => point.group === group);
    return { group, x: members.reduce((sum, point) => sum + point.x / members.length, 0), y: members.reduce((sum, point) => sum + point.y / members.length, 0) };
  });
  return <div className="space-y-2">
    <ToggleChips items={names} active={active} onToggle={toggle} />
    <div className="flex flex-wrap gap-3"><Switch label="중심점" checked={centers} onChange={setCenters} /><Switch label="라벨" checked={labels} onChange={setLabels} /></div>
    <PlotFrame options={{ x: { label: spec.xLabel }, y: { label: spec.yLabel }, color: { domain: names, scheme: 'tableau10', legend: true }, marks: [
      Plot.dot(points, { x: 'x', y: 'y', fill: 'group', r: 4 }),
      ...(centers ? [Plot.dot(means, { x: 'x', y: 'y', stroke: 'group', symbol: 'cross', r: 7, strokeWidth: 2 })] : []),
      ...(labels ? [Plot.text(points.filter(point => point.label), { x: 'x', y: 'y', text: 'label', dy: -8, fontSize: 10 })] : []),
      Plot.tip(points, Plot.pointer({ x: 'x', y: 'y', title: (d: typeof points[number]) => `${d.label || d.group}\n${d.group}\n${spec.xLabel}: ${format(d.x)}\n${spec.yLabel}: ${format(d.y)}` })),
    ] }} />
  </div>;
}

export function SurvivalWidget({ spec }: { spec: Spec<'survival'> }) {
  const names = spec.groups.map(group => group.name);
  const { active, toggle } = useVisible(names);
  const groups = spec.groups.filter(group => active.has(group.name));
  const steps = groups.flatMap(group => group.steps.map(step => ({ ...step, group: group.name })));
  const valueAt = (group: Spec<'survival'>['groups'][number], t: number) => {
    let value: number | undefined;
    for (const step of group.steps) { if (step.t > t) break; value = step.s; }
    return value;
  };
  const censored = groups.flatMap(group => (group.censored ?? []).flatMap(t => {
    const s = valueAt(group, t);
    return s === undefined ? [] : [{ t, s, group: group.name }];
  }));
  const times = [...new Set(steps.map(step => step.t))].sort((a, b) => a - b).map(t => ({ t, title: `${spec.timeLabel}: ${format(t)}\n${groups.map(group => { const s = valueAt(group, t); return `${group.name}: ${s === undefined ? '—' : format(s)}`; }).join('\n')}` }));
  return <div className="space-y-2">
    <ToggleChips items={names} active={active} onToggle={toggle} />
    <PlotFrame options={{ x: { label: spec.timeLabel }, y: { label: '생존율', domain: [0, 1] }, color: { domain: names, scheme: 'tableau10', legend: true }, marks: [
      Plot.line(steps, { x: 't', y: 's', z: 'group', stroke: 'group', curve: 'step-after' }),
      Plot.dot(censored, { x: 't', y: 's', stroke: 'group', symbol: 'plus', r: 4 }),
      Plot.ruleX(times, Plot.pointerX({ x: 't', stroke: 'currentColor', strokeOpacity: 0.4 })),
      Plot.tip(times, Plot.pointerX({ x: 't', title: 'title' })),
    ] }} />
  </div>;
}

export function DoseResponseWidget({ spec }: { spec: Spec<'doseResponse'> }) {
  const names = spec.curves.map(curve => curve.name);
  const { active, toggle } = useVisible(names);
  const [showEc50, setShowEc50] = useState(false);
  const bounds = useMemo(() => {
    const xs = spec.curves.flatMap(curve => [Math.max(Number.MIN_VALUE, curve.ec50 / 100), Math.min(Number.MAX_VALUE, curve.ec50 * 100), ...(curve.points ?? []).map(point => point.x)]);
    return [Math.log10(Math.min(...xs)), Math.log10(Math.max(...xs))] as const;
  }, [spec]);
  const [logDose, setLogDose] = useState(() => (bounds[0] + bounds[1]) / 2);
  const dose = 10 ** logDose;
  const response = (curve: Spec<'doseResponse'>['curves'][number], x: number) => curve.bottom + (curve.top - curve.bottom) / (1 + Math.exp(curve.hill * (Math.log(curve.ec50) - Math.log(x))));
  const curves = spec.curves.filter(curve => active.has(curve.name));
  const lines = curves.flatMap(curve => Array.from({ length: 120 }, (_, i) => {
    const x = 10 ** (bounds[0] + (bounds[1] - bounds[0]) * i / 119);
    return { x, y: response(curve, x), group: curve.name };
  }).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
  const points = curves.flatMap(curve => (curve.points ?? []).map(point => ({ ...point, group: curve.name })));
  return <div className="space-y-2">
    <ToggleChips items={names} active={active} onToggle={toggle} />
    <Switch label="EC50 표시" checked={showEc50} onChange={setShowEc50} />
    <RangeSlider label={`가상 농도 (${dose.toExponential(2)})`} value={logDose} min={bounds[0]} max={bounds[1]} step={(bounds[1] - bounds[0]) / 500} onChange={setLogDose} />
    <p className="text-xs text-fg-dim">{curves.map(curve => { const y = response(curve, dose); return `${curve.name}: ${Number.isFinite(y) ? format(y) : '—'}`; }).join(' · ')}</p>
    <PlotFrame options={{ x: { type: 'log', label: spec.xLabel }, y: { label: spec.yLabel }, color: { domain: names, scheme: 'tableau10', legend: true }, marks: [
      Plot.line(lines, { x: 'x', y: 'y', z: 'group', stroke: 'group' }),
      Plot.dot(points, { x: 'x', y: 'y', fill: 'group' }),
      ...(showEc50 ? [Plot.ruleX(curves, { x: 'ec50', stroke: 'name', strokeDasharray: '4,4' })] : []),
      Plot.ruleX([dose], { stroke: 'currentColor', strokeOpacity: 0.6 }),
      Plot.tip(points, Plot.pointer({ x: 'x', y: 'y', title: (d: typeof points[number]) => `${d.group}\n${spec.xLabel}: ${format(d.x)}\n${spec.yLabel}: ${format(d.y)}` })),
    ] }} />
  </div>;
}

export function FormulaWidget({ spec }: { spec: Spec<'formula'> }) {
  const initial = () => Object.fromEntries(spec.variables.map(variable => [variable.name, variable.value]));
  const [values, setValues] = useState<Record<string, number>>(initial);
  const [pins, setPins] = useState<Record<string, number>[]>([]);
  const expression = useMemo(() => parseExpr(spec.expression), [spec.expression]);
  const sample = (vars: Record<string, number>, group: string) => Array.from({ length: 200 }, (_, i) => {
    const x = spec.x.min * (1 - i / 199) + spec.x.max * (i / 199);
    const y = evalExpr(expression, { ...vars, [spec.x.name]: x });
    return { x, y, group };
  }).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
  const current = sample(values, 'current');
  const pinned = pins.flatMap((pin, i) => sample(pin, `pin${i}`));
  return <div className="space-y-2">
    <Markdown text={`$$\n${spec.latex}\n$$`} />
    {spec.variables.map(variable => <RangeSlider key={variable.name} label={variable.label} value={values[variable.name]} min={variable.min} max={variable.max} step={variable.step} unit={variable.unit} onChange={value => setValues(previous => ({ ...previous, [variable.name]: value }))} />)}
    <div className="flex flex-wrap gap-2">
      <button type="button" className={smallGhostBtnCls} disabled={pins.length >= 3} onClick={() => setPins(previous => [...previous, { ...values }])}>현재 곡선 고정 ({pins.length}/3)</button>
      <button type="button" className={smallGhostBtnCls} onClick={() => { setValues(initial()); setPins([]); }}>초기화</button>
    </div>
    <PlotFrame options={{ x: { label: spec.x.label, domain: [spec.x.min, spec.x.max] }, y: { label: spec.yLabel }, marks: [
      Plot.line(pinned, { x: 'x', y: 'y', z: 'group', stroke: 'var(--pr-fg-dim)', strokeDasharray: '5,4' }),
      Plot.line(current, { x: 'x', y: 'y', stroke: 'var(--pr-accent)', strokeWidth: 2 }),
      Plot.tip(current, Plot.pointerX({ x: 'x', y: 'y', title: (d: typeof current[number]) => `${spec.x.label}: ${format(d.x)}\n${spec.yLabel}: ${format(d.y)}` })),
    ] }} />
  </div>;
}
