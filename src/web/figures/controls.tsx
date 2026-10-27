import { chipCls } from '../components/Dialog';

export function ToggleChips({ items, active, onToggle }: { items: string[]; active: Set<string>; onToggle: (item: string) => void }) {
  return <div className="flex flex-wrap gap-1">{items.map(item => <button key={item} type="button" className={chipCls(active.has(item))} aria-pressed={active.has(item)} onClick={() => onToggle(item)}>{item}</button>)}</div>;
}

export function Switch({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <label className="inline-flex items-center gap-1.5 text-xs text-fg-muted disabled:opacity-50"><input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />{label}</label>;
}

export function RangeSlider({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void }) {
  return <label className="flex flex-wrap items-center gap-2 text-xs text-fg-muted"><span>{label}: {Number(value.toPrecision(5))}{unit ? ` ${unit}` : ''}</span><input className="min-w-24 flex-1" type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} /></label>;
}
