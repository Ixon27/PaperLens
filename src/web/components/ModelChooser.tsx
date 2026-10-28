import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

/** The icon represents the selected level, not its position in a model-specific list. */
function EffortRing({ value, levels }: { value: string; levels: string[] }) {
  if (value === 'max') {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" className="shrink-0">
        <path fill="var(--pr-effort-max)" d="M12.8 1.5c.7 3.8-1.2 5.1-2.2 6.5-.9-1-1.2-2.1-1.1-3.3C6.2 7.3 4 10.8 4 14.2 4 18.9 7.4 22 12 22s8-3.1 8-7.8c0-4.1-2.6-7.3-7.2-12.7Z" />
        <path fill="var(--pr-warning)" d="M12.5 11.1c.3 1.7-.7 2.5-1.3 3.2-.5-.5-.7-1.1-.7-1.7-1.3 1.2-2.1 2.7-2.1 4.1a3.6 3.6 0 0 0 7.2 0c0-1.8-1.1-3.4-3.1-5.6Z" />
      </svg>
    );
  }
  const fractions: Record<string, number> = { minimal: 0.14, low: 0.25, medium: 0.5, high: 0.75, xhigh: 0.92 };
  const fraction = value === '' ? 0 : fractions[value] ?? (levels.includes(value) ? (levels.indexOf(value) + 1) / levels.length : 0.5);
  const color = value === 'high' ? 'var(--pr-accent)' : value === 'xhigh' ? 'var(--pr-effort)' : 'var(--pr-fg-muted)';
  const circumference = 2 * Math.PI * 5;
  return (
    <svg width="18" height="18" viewBox="0 0 14 14" aria-hidden="true" className="shrink-0">
      <circle cx="7" cy="7" r="5" fill="none" stroke="var(--pr-line-strong)" strokeWidth="2" />
      {value === '' ? (
        <circle cx="7" cy="7" r="5" fill="none" stroke="var(--pr-fg-dim)" strokeWidth="2" strokeLinecap="round" strokeDasharray="0.1 3.05" />
      ) : (
        <circle cx="7" cy="7" r="5" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round"
          transform="rotate(-90 7 7)" strokeDasharray={`${circumference * fraction} ${circumference}`} />
      )}
    </svg>
  );
}

const isTextEntry = () => {
  const active = document.activeElement;
  return active instanceof HTMLElement && (active.isContentEditable || !!active.closest('input, textarea, select, [contenteditable], [role="textbox"]'));
};

/** Do not steal Shift+Tab from text entry or keyboard focus navigation. */
const canUseHoverShortcut = () => {
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement) return true;
  return active instanceof HTMLElement && !isTextEntry() && !active.matches(':focus-visible');
};

/** Cycle only through the selected model's supported levels and its CLI default. */
export function EffortControl({ label, value, levels, onChange, disabled = false }: {
  label: string;
  value: string;
  levels: string[];
  onChange(value: string): void;
  disabled?: boolean;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const keyboardFocus = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const tooltipId = useId();
  const [hovered, setHovered] = useState(false);
  const [shortcutReady, setShortcutReady] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const options = ['', ...new Set(levels.filter((level) => level !== ''))];
  const next = options[(options.indexOf(value) + 1) % options.length];
  const nextRef = useRef(next);
  const onChangeRef = useRef(onChange);
  const shortcutReadyRef = useRef(false);
  nextRef.current = next;
  onChangeRef.current = onChange;
  const inactive = disabled || levels.length === 0;
  const name = effortLabel(value);

  const hide = () => {
    clearTimeout(timer.current);
    setPosition(null);
  };
  const show = (delay: number) => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 238;
      setPosition({
        top: rect.bottom + 8 + 38 <= window.innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - 46),
        left: Math.max(8, Math.min(rect.left - 8, window.innerWidth - width - 8)),
      });
    }, delay);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!position) return;
    const close = () => hide();
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); };
  }, [position]);
  useEffect(() => {
    if (!hovered || inactive) return;
    const update = () => {
      const ready = canUseHoverShortcut();
      shortcutReadyRef.current = ready;
      setShortcutReady(ready);
    };
    const afterFocus = () => queueMicrotask(update);
    const cycle = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || !shortcutReadyRef.current || isTextEntry()) return;
      event.preventDefault();
      onChangeRef.current(nextRef.current);
    };
    update();
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', afterFocus);
    window.addEventListener('keydown', cycle);
    return () => {
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', afterFocus);
      window.removeEventListener('keydown', cycle);
    };
  }, [hovered, inactive]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`${label} thinking effort: ${name}${inactive ? '' : ` · 클릭하여 ${effortLabel(next)}로 변경`}`}
        aria-describedby={position ? tooltipId : undefined}
        disabled={inactive}
        className="no-drag inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
        onMouseEnter={() => { setHovered(true); show(150); }}
        onMouseLeave={() => { setHovered(false); if (!keyboardFocus.current) hide(); }}
        onFocus={() => {
          keyboardFocus.current = buttonRef.current?.matches(':focus-visible') ?? false;
          if (keyboardFocus.current) show(0);
        }}
        onBlur={() => { keyboardFocus.current = false; if (!hovered) hide(); }}
        onClick={() => onChange(next)}
      >
        <span className="grid h-7 w-7 place-items-center rounded-full bg-sunken"><EffortRing value={value} levels={levels} /></span>
      </button>
      {position && createPortal(
        <div id={tooltipId} role="tooltip" className="pointer-events-none fixed z-[100] flex h-[38px] w-[238px] items-center justify-between gap-2 rounded-xl border border-line-strong bg-raised px-3 text-[13px] text-fg shadow-pop" style={position}>
          <span className="whitespace-nowrap">Thinking effort: {name}</span>
          {hovered && shortcutReady && <span aria-hidden="true" className="flex items-center gap-1">
            <kbd className="grid h-6 min-w-6 place-items-center rounded-md border border-line-strong bg-sunken px-1 font-sans text-[14px] text-fg-muted">⇧</kbd>
            <kbd className="grid h-6 min-w-6 place-items-center rounded-md border border-line-strong bg-sunken px-1 font-sans text-[14px] text-fg-muted">⇥</kbd>
          </span>}
        </div>,
        document.body,
      )}
    </>
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

/** Model list for one engine. */
export function ModelList({
  label,
  engine,
  catalog,
  loading,
  error,
  model,
  onModel,
}: {
  label: string;
  engine: EngineId;
  catalog: ModelCatalog | null;
  loading: boolean;
  error: string | null;
  model: string;
  onModel(m: ModelChoice): void;
}) {
  const choices = choicesFor(engine, catalog, model);
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
    </div>
  );
}
