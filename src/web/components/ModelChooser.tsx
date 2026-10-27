import { Check } from 'lucide-react';
import type { EngineId, ModelCatalog, ModelChoice } from '../../shared/models';
import { effortLabel, engineLabel } from '../labels';

export const ENGINES: EngineId[] = ['claude', 'codex'];

/** The models shown for an engine: catalog entries, Codex's "CLI default", and the saved value if the CLI no longer lists it. */
export function choicesFor(engine: EngineId, catalog: ModelCatalog | null, current: string): ModelChoice[] {
  const listed = catalog?.[engine].models ?? [];
  const list: ModelChoice[] = [];
  if (engine === 'codex') {
    list.push({ value: '', label: 'CLI 기본 모델', description: 'Codex가 정한 기본 모델', efforts: listed.find((m) => m.isDefault)?.efforts ?? [] });
  }
  list.push(...listed);
  if (!list.some((m) => m.value === current)) list.push({ value: current, label: current, description: '현재 설정 · 목록에 없음', efforts: [] });
  return list;
}

export function modelLabel(engine: EngineId, catalog: ModelCatalog | null, value: string): string {
  const listed = catalog?.[engine].models.find((m) => m.value === value);
  if (listed) return listed.label;
  if (engine === 'codex' && value === '') return 'CLI 기본';
  return value;
}

/** Keep the effort when the new model accepts it; otherwise the model's default, else no flag. */
export function effortAfterModelChange(cur: string, m: ModelChoice): string {
  if (cur === '' || m.efforts.includes(cur)) return cur;
  return m.defaultEffort && m.efforts.includes(m.defaultEffort) ? m.defaultEffort : '';
}

export function EffortRing({ value, levels, size = 14 }: { value: string; levels: string[]; size?: number }) {
  const c = 2 * Math.PI * 5;
  const f = value === '' ? 0 : levels.includes(value) ? (levels.indexOf(value) + 1) / levels.length : 0.5;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden className="shrink-0">
      <circle cx="7" cy="7" r="5" fill="none" stroke="var(--pr-line-strong)" strokeWidth="2" />
      <circle
        cx="7"
        cy="7"
        r="5"
        fill="none"
        stroke="var(--pr-effort)"
        strokeWidth="2"
        strokeLinecap="round"
        transform="rotate(-90 7 7)"
        opacity={f === 0 ? 0 : 1}
        strokeDasharray={`${c * f} ${c}`}
        style={{ transition: 'stroke-dasharray 220ms var(--ease-out)' }}
      />
    </svg>
  );
}

/** Claude | Codex segmented control; an engine whose CLI is missing is disabled. */
export function EngineTabs({ value, engines, onChange }: { value: EngineId; engines: Record<EngineId, boolean>; onChange(e: EngineId): void }) {
  return (
    <div role="radiogroup" aria-label="AI 엔진" className="relative grid grid-cols-2 gap-1 rounded-xl bg-sunken p-1">
      <span
        aria-hidden
        className="absolute top-1 left-1 h-8 w-[calc(50%-6px)] rounded-lg bg-raised shadow-sm transition-transform duration-200 ease-out"
        style={{ transform: value === 'codex' ? 'translateX(calc(100% + 4px))' : 'translateX(0)' }}
      />
      {ENGINES.map((e) => (
        <button
          key={e}
          role="radio"
          aria-checked={value === e}
          disabled={!engines[e]}
          title={engines[e] ? undefined : '설치되어 있지 않습니다'}
          className={`relative h-8 rounded-lg text-[13px] font-medium transition-colors duration-150 disabled:opacity-40 ${
            value === e ? 'text-fg' : 'text-fg-muted hover:text-fg'
          }`}
          onClick={() => {
            if (e !== value) onChange(e);
          }}
        >
          {engineLabel(e)}
        </button>
      ))}
    </div>
  );
}

/** Model list + 작업 수준 chips for one engine. */
export function ModelList({
  label,
  engine,
  catalog,
  loading,
  error,
  model,
  effort,
  onModel,
  onEffort,
}: {
  label: string;
  engine: EngineId;
  catalog: ModelCatalog | null;
  loading: boolean;
  error: string | null;
  model: string;
  effort: string;
  onModel(m: ModelChoice): void;
  onEffort(v: string): void;
}) {
  const choices = choicesFor(engine, catalog, model);
  const levels = choices.find((m) => m.value === model)?.efforts ?? [];
  const efforts = ['', ...levels];
  if (!efforts.includes(effort)) efforts.push(effort);
  return (
    <div className="px-1 pt-1 pb-3">
      {error && <p className="mb-1.5 px-1 text-[12px] text-warning">{error}</p>}
      <div role="radiogroup" aria-label={`${label} 모델`} className="max-h-[240px] overflow-y-auto rounded-lg border border-line bg-surface p-1">
        {loading
          ? [0, 1, 2].map((i) => <div key={i} className="m-0.5 h-9 animate-pulse rounded-md bg-sunken" />)
          : choices.map((m) => {
              const on = m.value === model;
              return (
                <button
                  key={m.value || '(cli-default)'}
                  role="radio"
                  aria-checked={on}
                  className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors duration-150 hover:bg-hover"
                  onClick={() => onModel(m)}
                >
                  {on ? <Check size={14} className="mt-0.5 shrink-0 text-accent" /> : <span className="w-[14px] shrink-0" />}
                  <span className="min-w-0 flex-1">
                    <span className={`block text-[13px] text-fg ${on ? 'font-medium' : ''}`}>{m.label}</span>
                    {m.description && <span className="line-clamp-1 text-[11.5px] text-fg-muted">{m.description}</span>}
                  </span>
                </button>
              );
            })}
      </div>
      <div className="mt-2.5 flex items-start gap-2 px-1">
        <span className="w-16 shrink-0 pt-1.5 text-[12px] text-fg-muted">작업 수준</span>
        <div role="radiogroup" aria-label={`${label} 작업 수준`} className="flex flex-wrap gap-1.5">
          {efforts.map((v) => (
            <button
              key={v || '(default)'}
              role="radio"
              aria-checked={v === effort}
              className={`h-7 rounded-full border px-2.5 text-[12px] transition-colors duration-150 ${
                v === effort ? 'border-accent/50 bg-accent-soft text-accent' : 'border-line text-fg-muted hover:bg-hover hover:text-fg'
              }`}
              onClick={() => onEffort(v)}
            >
              {effortLabel(v)}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1.5 pl-[4.75rem] text-[11px] text-fg-dim">높을수록 더 깊이 생각하지만 느리고 사용량이 늘어납니다.</p>
    </div>
  );
}
