import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { api } from '../api';
import type { Settings } from '../types';
import type { EngineId, ModelCatalog, ModelChoice } from '../../shared/models';
import { effortLabel, engineLabel } from '../labels';
import { useModelCatalog } from '../state/models';
import { iconBtnCls } from './Dialog';
import { EffortRing, EngineTabs, ModelList, choicesFor, effortAfterModelChange, modelLabel } from './ModelChooser';
import { usePresence } from './motion';
import { useToast } from './Toast';

type Profile = 'quick' | 'heavy';
type Patch = { engine?: EngineId; claude?: Partial<Settings['claude']>; codex?: Partial<Settings['codex']> };

const PROFILES: { id: Profile; title: string; subtitle: string }[] = [
  { id: 'quick', title: '빠른 작업', subtitle: '번역 · 요약 · 토론 · 용어' },
  { id: 'heavy', title: '깊은 작업', subtitle: '심층 분석 · 마인드맵' },
];

function applyPatch(s: Settings, p: Patch): Settings {
  return { ...s, engine: p.engine ?? s.engine, claude: { ...s.claude, ...p.claude }, codex: { ...s.codex, ...p.codex } };
}

const modelKey = (p: Profile) => (p === 'quick' ? 'quickModel' : 'heavyModel');
const effortKey = (p: Profile) => (p === 'quick' ? 'quickEffort' : 'heavyEffort');

function ProfileRow({
  title,
  subtitle,
  engine,
  catalog,
  loading,
  error,
  model,
  effort,
  expanded,
  onToggle,
  onModel,
  onEffort,
}: {
  title: string;
  subtitle: string;
  engine: EngineId;
  catalog: ModelCatalog | null;
  loading: boolean;
  error: string | null;
  model: string;
  effort: string;
  expanded: boolean;
  onToggle(): void;
  onModel(m: ModelChoice): void;
  onEffort(v: string): void;
}) {
  const levels = choicesFor(engine, catalog, model).find((m) => m.value === model)?.efforts ?? [];
  return (
    <div>
      <button
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors duration-150 hover:bg-hover"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <EffortRing value={effort} levels={levels} size={16} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-fg">{title}</span>
          <span className="block text-[11.5px] text-fg-dim">{subtitle}</span>
        </span>
        <span className="min-w-0 max-w-[45%] text-right">
          <span className="block truncate text-[12.5px] text-fg">{modelLabel(engine, catalog, model)}</span>
          <span className="block font-mono text-[11.5px] text-fg-muted">{effortLabel(effort)}</span>
        </span>
        <ChevronDown size={14} className={`shrink-0 text-fg-muted transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
      </button>
      <div className="pr-accordion" data-open={expanded || undefined}>
        <div
          ref={(el) => {
            if (el) el.inert = !expanded;
          }}
        >
          <ModelList
            label={title}
            engine={engine}
            catalog={catalog}
            loading={loading}
            error={error}
            model={model}
            effort={effort}
            onModel={onModel}
            onEffort={onEffort}
          />
        </div>
      </div>
    </div>
  );
}

/** Top-bar model · effort picker. Changes save immediately; the catalog is CLI metadata only. */
export function AiPicker() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [engines, setEngines] = useState<Record<EngineId, boolean>>({ claude: true, codex: true });
  const { catalog, loading: catalogLoading, error: catalogError, refresh } = useModelCatalog();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Profile | null>(null);
  const presence = usePresence(open, 120);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const toast = useToast();

  useEffect(() => {
    Promise.all([api<Settings>('/api/settings'), api<Record<EngineId, boolean>>('/api/engines')])
      .then(([s, e]) => {
        setSettings(s);
        setEngines(e);
      })
      .catch((e: unknown) => toast(e instanceof Error ? e.message : 'AI 설정을 불러오지 못했습니다', { tone: 'error' }));
  }, [toast]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      pillRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!settings) return null;

  const patch = async (p: Patch) => {
    const prev = settings;
    setSettings(applyPatch(prev, p));
    try {
      setSettings(await api<Settings>('/api/settings', { method: 'PUT', json: p }));
    } catch (e) {
      setSettings(prev);
      toast(e instanceof Error ? e.message : '설정을 저장하지 못했습니다', { tone: 'error' });
    }
  };

  const engine = settings.engine;
  const profiles = settings[engine];
  const selectModel = (profile: Profile, m: ModelChoice) => {
    void patch({ [engine]: { [modelKey(profile)]: m.value, [effortKey(profile)]: effortAfterModelChange(profiles[effortKey(profile)], m) } });
  };
  const selectEffort = (profile: Profile, v: string) => void patch({ [engine]: { [effortKey(profile)]: v } });

  const levelsOf = (value: string) => choicesFor(engine, catalog, value).find((m) => m.value === value)?.efforts ?? [];
  const quickLabel = modelLabel(engine, catalog, profiles.quickModel);
  const heavyLabel = modelLabel(engine, catalog, profiles.heavyModel);
  const engineError = catalogError ?? catalog?.[engine].error ?? null;
  const status = catalogLoading ? '모델 목록 불러오는 중…' : engineError ?? 'CLI에서 불러온 목록';

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={pillRef}
        className="no-drag inline-flex h-8 max-w-[360px] items-center gap-2 rounded-full border border-line bg-raised pr-2 pl-2.5 text-[13px] transition-[border-color,transform] duration-150 hover:border-line-strong active:scale-[0.98]"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`빠른 작업: ${quickLabel} · ${effortLabel(profiles.quickEffort)}\n깊은 작업: ${heavyLabel} · ${effortLabel(profiles.heavyEffort)}`}
        onClick={() => setOpen((o) => !o)}
      >
        <EffortRing value={profiles.quickEffort} levels={levelsOf(profiles.quickModel)} />
        <span className="font-medium text-accent">{engineLabel(engine)}</span>
        <span className="truncate text-fg">{quickLabel}</span>
        {heavyLabel !== quickLabel && (
          <>
            <span className="text-fg-dim">·</span>
            <span className="truncate text-fg-muted">{heavyLabel}</span>
          </>
        )}
        <ChevronDown size={14} className={`shrink-0 text-fg-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {presence.mounted && (
        <div
          role="dialog"
          aria-label="AI 모델"
          className="pr-pop no-drag absolute top-[calc(100%+8px)] right-0 z-[70] max-h-[calc(100vh-80px)] w-[380px] overflow-y-auto rounded-2xl border border-line bg-raised p-2 shadow-pop"
          style={{ '--pr-origin': 'top right' } as CSSProperties}
          data-closing={presence.closing || undefined}
        >
          <EngineTabs value={engine} engines={engines} onChange={(e) => void patch({ engine: e })} />
          <div className="mt-1">
            {PROFILES.map((p) => (
              <ProfileRow
                key={p.id}
                title={p.title}
                subtitle={p.subtitle}
                engine={engine}
                catalog={catalog}
                loading={catalogLoading && !catalog}
                error={engineError}
                model={profiles[modelKey(p.id)]}
                effort={profiles[effortKey(p.id)]}
                expanded={expanded === p.id}
                onToggle={() => setExpanded((x) => (x === p.id ? null : p.id))}
                onModel={(m) => selectModel(p.id, m)}
                onEffort={(v) => selectEffort(p.id, v)}
              />
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-line px-2 pt-2">
            <span className="min-w-0 truncate text-[11.5px] text-fg-dim" title={status}>
              {status}
            </span>
            <button
              className={iconBtnCls}
              aria-label="모델 목록 새로고침"
              title="모델 목록 새로고침"
              onClick={() => {
                if (!catalogLoading) refresh();
              }}
            >
              <RefreshCw size={14} className={catalogLoading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
