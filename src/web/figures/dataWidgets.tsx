import { useMemo, useState } from 'react';
import type { FigureSpec } from '../../shared/figure-spec';
import { inputCls } from '../components/Dialog';
import { Switch } from './controls';

type Compare = Extract<FigureSpec, { kind: 'compare' }>;
type Table = Extract<FigureSpec, { kind: 'table' }>;
const numberText = (n: number) => Number(n.toPrecision(4)).toLocaleString();

export function CompareWidget({ spec }: { spec: Compare }) {
  const [baseline, setBaseline] = useState(0);
  return (
    <div className="space-y-4 text-[12.5px]">
      <label className="flex items-center gap-2">기준 조건
        <select className="rounded border border-line bg-surface p-1" value={baseline} onChange={(e) => setBaseline(Number(e.target.value))}>
          {spec.conditions.map((condition, i) => <option key={i} value={i}>{condition}</option>)}
        </select>
      </label>
      {spec.metrics.map((metric, mi) => {
        const nums = metric.values.filter((v): v is number => v !== null);
        const maxMagnitude = Math.max(...nums.map(Math.abs), 0);
        const best = metric.higherIsBetter === undefined || !nums.length ? null : metric.higherIsBetter ? Math.max(...nums) : Math.min(...nums);
        const reference = metric.values[baseline];
        const hasNegative = nums.some((v) => v < 0);
        return (
          <div key={mi} className="space-y-1">
            <div className="font-semibold text-fg">{metric.name}{metric.unit ? ` (${metric.unit})` : ''}</div>
            {spec.conditions.map((condition, i) => {
              const value = metric.values[i];
              const ratio = value !== null && reference !== null && reference !== 0 ? value / reference : null;
              const diff = value !== null && reference !== null ? value - reference : null;
              const pct = value !== null && maxMagnitude ? Math.abs(value) / maxMagnitude * (hasNegative ? 50 : 100) : 0;
              return (
                <div key={i} className="grid grid-cols-[minmax(4rem,1fr)_minmax(4rem,2fr)_auto] items-center gap-2">
                  <span className={value !== null && value === best ? 'font-semibold text-accent' : 'text-fg-muted'}>{condition}</span>
                  <div className="relative h-3 rounded bg-sunken" aria-hidden="true">
                    {hasNegative && <div className="absolute inset-y-0 left-1/2 w-px bg-line-strong" />}
                    {value !== null && <div className="absolute inset-y-0 rounded bg-accent/70" style={{ left: hasNegative ? `${value < 0 ? 50 - pct : 50}%` : '0%', width: `${pct}%` }} />}
                  </div>
                  <span className="text-right tabular-nums">{value === null ? '—' : numberText(value)}{ratio === null ? '' : ` · ×${numberText(ratio)}`}{diff === null ? '' : ` · ${diff >= 0 ? '+' : ''}${numberText(diff)}`}</span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export function TableWidget({ spec }: { spec: Table }) {
  const [filter, setFilter] = useState('');
  const [intensity, setIntensity] = useState(false);
  const [sort, setSort] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
  const rows = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    const filtered = spec.rows.map((row, index) => ({ row, index })).filter(({ row }) => !query || spec.columns.some((c) => String(row[c.key] ?? '').toLocaleLowerCase().includes(query)));
    if (!sort) return filtered;
    const column = spec.columns.find((c) => c.key === sort.key);
    return filtered.sort((a, b) => {
      const x = a.row[sort.key], y = b.row[sort.key];
      if (x == null || y == null) return x == null && y == null ? a.index - b.index : x == null ? 1 : -1;
      const nx = Number(x), ny = Number(y);
      const compared = column?.numeric && Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : String(x).localeCompare(String(y), undefined, { numeric: true });
      return (sort.direction === 'asc' ? compared : -compared) || a.index - b.index;
    });
  }, [filter, sort, spec]);
  const ranges = useMemo(() => new Map(spec.columns.filter((c) => c.numeric).map((c) => {
    const values = spec.rows.map((r) => r[c.key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return [c.key, values.length ? { min: Math.min(...values), max: Math.max(...values) } : null];
  })), [spec]);
  const highlights = new Set(spec.highlight ?? []);
  const cycle = (key: string) => setSort((old) => !old || old.key !== key ? { key, direction: 'asc' } : old.direction === 'asc' ? { key, direction: 'desc' } : null);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${inputCls} max-w-[220px]`} type="search" aria-label="표 필터" placeholder="표에서 찾기" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Switch label="색 농도" checked={intensity} onChange={setIntensity} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-[12px]">
          <thead><tr>{spec.columns.map((c) => <th key={c.key} className="border border-line bg-sunken px-2 py-1" aria-sort={sort?.key === c.key ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button type="button" className="w-full text-left" onClick={() => cycle(c.key)}>{c.label}{c.unit ? ` (${c.unit})` : ''}{sort?.key === c.key ? sort.direction === 'asc' ? ' ↑' : ' ↓' : ''}</button></th>)}</tr></thead>
          <tbody>{rows.map(({ row, index }) => <tr key={index} className={highlights.has(index) ? 'bg-accent-soft' : ''}>{spec.columns.map((c) => {
            const value = row[c.key], range = ranges.get(c.key);
            const amount = intensity && typeof value === 'number' && range ? (range.max === range.min ? 0.5 : (value - range.min) / (range.max - range.min)) : 0;
            return <td key={c.key} className="border border-line px-2 py-1 tabular-nums" style={amount ? { backgroundColor: `color-mix(in srgb, var(--pr-accent) ${Math.round(6 + 24 * amount)}%, transparent)` } : undefined}>{value === null ? '—' : value}</td>;
          })}</tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}
