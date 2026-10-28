import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { api } from '../api';
import type { Settings } from '../types';
import type { EngineId, ModelSpec } from '../../shared/models';
import { useModelCatalog } from '../state/models';
import { formatMadeBy } from './ModelBadge';
import { EffortControl, EngineTabs, ModelList, choicesFor, effortAfterModelChange, modelLabel } from './ModelChooser';
import { engineLabel } from '../labels';
import { usePresence } from './motion';

const quickSpec = (s: Settings, engine: EngineId): ModelSpec => ({ engine, model: s[engine].quickModel, effort: s[engine].quickEffort });

const POP_W = 340;

/** Fixed-position box beside the pill: the pill sits in scrolling, clipping panels. */
function popoverStyle(rect: DOMRect, placement: 'down' | 'up'): CSSProperties {
  const style: Record<string, string | number> = {};
  if (placement === 'down') {
    style.top = rect.bottom + 8;
    style.maxHeight = innerHeight - rect.bottom - 16;
  } else {
    style.bottom = innerHeight - rect.top + 8;
    style.maxHeight = rect.top - 16;
  }
  if (rect.right - POP_W < 8) style.left = 8;
  else style.right = innerWidth - rect.right;
  style['--pr-origin'] = placement === 'down' ? 'top right' : 'bottom right';
  style['--pr-pop-dy'] = placement === 'down' ? '-4px' : '4px';
  return style as CSSProperties;
}

/** The model of one conversation; `null` follows the 빠른 작업 setting. */
export function ChatModelPicker({
  value,
  disabled,
  onChange,
  placement = 'down',
}: {
  value: ModelSpec | null;
  disabled: boolean;
  onChange(v: ModelSpec | null): void;
  placement?: 'down' | 'up';
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [engines, setEngines] = useState<Record<EngineId, boolean>>({ claude: true, codex: true });
  const { catalog, loading, error } = useModelCatalog();
  const [open, setOpen] = useState(false);
  const [popStyle, setPopStyle] = useState<CSSProperties>({});
  const presence = usePresence(open, 120);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const settingsVersion = useRef(0);

  useEffect(() => {
    const onSettings = (event: Event) => {
      settingsVersion.current++;
      setSettings((event as CustomEvent<Settings>).detail);
    };
    window.addEventListener('paperlens-model-settings', onSettings);
    return () => window.removeEventListener('paperlens-model-settings', onSettings);
  }, []);

  // The 빠른 작업 setting can change in the top bar at any time, so read it again on every open.
  const load = useCallback(() => {
    const version = settingsVersion.current;
    Promise.all([api<Settings>('/api/settings'), api<Record<EngineId, boolean>>('/api/engines')])
      .then(([s, e]) => {
        if (settingsVersion.current === version) setSettings(s);
        setEngines(e);
      })
      .catch(() => {});
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      pillRef.current?.focus();
    };
    const close = () => setOpen(false);
    // The popover is fixed: any scrolling container around the pill would leave it behind.
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && wrapRef.current && e.target.contains(wrapRef.current)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  if (!settings) return null;
  const defaultSpec = quickSpec(settings, settings.engine);
  const shown = value ?? defaultSpec;
  const engineError = error ?? catalog?.[shown.engine].error ?? null;

  return (
    <div ref={wrapRef} className="relative inline-flex min-w-0 items-center rounded-full border border-line">
      <EffortControl
        label="Chat"
        value={shown.effort}
        levels={choicesFor(shown.engine, catalog, shown.model).find((m) => m.value === shown.model)?.efforts ?? []}
        disabled={disabled}
        onChange={(effort) => onChange({ ...shown, effort })}
      />
      <button
        ref={pillRef}
        className="inline-flex h-7 max-w-[min(200px,100%)] min-w-0 items-center gap-1.5 rounded-full pr-2.5 text-[12px] text-fg-muted transition-colors duration-150 hover:text-fg disabled:opacity-50"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        title={value === null ? '기본 설정(빠른 작업)을 따릅니다' : undefined}
        onClick={() => {
          if (!open && pillRef.current) setPopStyle(popoverStyle(pillRef.current.getBoundingClientRect(), placement));
          setOpen((o) => !o);
        }}
      >
        <span className="truncate">{engineLabel(shown.engine)} · {modelLabel(shown.engine, catalog, shown.model)}</span>
        <ChevronDown size={12} className={`shrink-0 transition-transform duration-200 ${open !== (placement === 'up') ? 'rotate-180' : ''}`} />
      </button>
      {presence.mounted &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label="이 대화의 모델"
            className="pr-pop fixed z-[70] w-[340px] overflow-y-auto rounded-2xl border border-line bg-raised p-2 shadow-pop"
            style={popStyle}
            data-closing={presence.closing || undefined}
          >
            <button
              role="radio"
              aria-checked={value === null}
              className="mb-2 flex w-full items-start gap-2.5 rounded-xl px-3 py-2 text-left transition-colors duration-150 hover:bg-hover"
              onClick={() => onChange(null)}
            >
              <span
                aria-hidden
                className={`mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border ${value === null ? 'border-accent' : 'border-line-strong'}`}
              >
                {value === null && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-fg">기본 설정 따르기</span>
                <span className="block truncate text-[11.5px] text-fg-dim">{formatMadeBy(defaultSpec, catalog)}</span>
              </span>
            </button>
            <EngineTabs value={shown.engine} engines={engines} onChange={(e) => onChange(quickSpec(settings, e))} />
            <div className="mt-1">
              <ModelList
                label="이 대화"
                engine={shown.engine}
                catalog={catalog}
                loading={loading && !catalog}
                error={engineError}
                model={shown.model}
                onModel={(m) => onChange({ engine: shown.engine, model: m.value, effort: effortAfterModelChange(shown.effort, m) })}
              />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
