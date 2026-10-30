import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { api } from '../api';
import type { Settings } from '../types';
import type { EngineId, ModelCatalog, ModelChoice } from '../../shared/models';
import { effortLabel, engineLabel } from '../labels';
import { refreshCatalogAfterProviderChange, useModelCatalog } from '../state/models';
import { iconBtnCls } from './Dialog';
import { EffortControl, EngineTabs, ModelList, choicesFor, effortAfterModelChange, modelLabel } from './ModelChooser';
import { usePresence } from './motion';
import { useToast } from './Toast';

type Profile = 'quick' | 'heavy';
type Patch = { engine?: EngineId; claude?: Partial<Settings['claude']>; codex?: Partial<Settings['codex']> };

const PROFILES: { id: Profile; title: string; subtitle: string }[] = [
  { id: 'quick', title: '빠른 작업', subtitle: '번역 · 요약 · 핵심 용어 · 용어 설명 · 대화 · 참고문헌 추출 · 분야 판별 · 내보내기 이름' },
  { id: 'heavy', title: '깊은 작업', subtitle: 'Deep Research · 추가 분석 · 마인드맵 · 퀴즈 생성 · 인터랙티브 그림 · 연구 계보' },
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
      <div className="flex items-center gap-1 rounded-xl px-2">
        <EffortControl label={title} value={effort} levels={levels} onChange={onEffort} />
        <button
          className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors duration-150 hover:bg-hover"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-fg">{title}</span>
            <span className="block text-[11.5px] text-fg-dim">{subtitle}</span>
          </span>
          <span className="min-w-0 max-w-[45%] truncate text-[12.5px] text-fg">{modelLabel(engine, catalog, model)}</span>
          <ChevronDown size={14} className={`shrink-0 text-fg-muted transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
        </button>
      </div>
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
            onModel={onModel}
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
  const heavyPillRef = useRef<HTMLButtonElement>(null);
  const openedFromRef = useRef<Profile>('quick');
  const savedRef = useRef<Settings | null>(null);
  const pendingRef = useRef<Patch[]>([]);
  const savingRef = useRef(false);
  const toast = useToast();

  useEffect(() => {
    Promise.all([api<Settings>('/api/settings'), api<Record<EngineId, boolean>>('/api/engines')])
      .then(([s, e]) => {
        savedRef.current = s;
        setSettings(s);
        setEngines(e);
      })
      .catch((e: unknown) => toast(e instanceof Error ? e.message : 'AI 설정을 불러오지 못했습니다', { tone: 'error' }));
  }, [toast]);

  useEffect(() => {
    let disposed = false;
    const watchers = new Map<EngineId, number>();
    const onProviderChanged = () => {
      void api<Record<EngineId, boolean>>('/api/engines').then(setEngines).catch(() => {});
      void api<Settings>('/api/settings').then((s) => {
        if (savingRef.current) return;
        savedRef.current = s;
        setSettings(s);
        window.dispatchEvent(new CustomEvent('paperlens-model-settings', { detail: s }));
      }).catch(() => {});
      void refreshCatalogAfterProviderChange();
    };
    const watchProvider = async (engine: EngineId) => {
      try {
        const status = await api<{ operation: { state: string } | null }>(`/api/providers/${engine}`);
        if (disposed) return;
        if (status.operation?.state === 'running') {
          watchers.set(engine, window.setTimeout(() => void watchProvider(engine), 2000));
          return;
        }
      } catch { /* Reopening AI 연결 can refresh a failed status check. */ }
      watchers.delete(engine);
      if (!disposed) onProviderChanged();
    };
    const onProviderStarted = (event: Event) => {
      const engine = (event as CustomEvent<EngineId>).detail;
      if ((engine !== 'claude' && engine !== 'codex') || watchers.has(engine)) return;
      watchers.set(engine, 0);
      void watchProvider(engine);
    };
    window.addEventListener('paperlens-provider-changed', onProviderChanged);
    window.addEventListener('paperlens-provider-started', onProviderStarted);
    return () => {
      disposed = true;
      for (const timer of watchers.values()) clearTimeout(timer);
      window.removeEventListener('paperlens-provider-changed', onProviderChanged);
      window.removeEventListener('paperlens-provider-started', onProviderStarted);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    void api<Record<EngineId, boolean>>('/api/engines')
      .then(setEngines)
      .catch(() => {});
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      (openedFromRef.current === 'heavy' ? heavyPillRef : pillRef).current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!settings) return null;

  const patch = (p: Patch) => {
    pendingRef.current.push(p);
    const update = () => {
      if (savedRef.current) {
        const current = pendingRef.current.reduce(applyPatch, savedRef.current);
        setSettings(current);
        window.dispatchEvent(new CustomEvent('paperlens-model-settings', { detail: current }));
      }
    };
    update();
    if (savingRef.current) return;
    savingRef.current = true;
    void (async () => {
      while (pendingRef.current.length) {
        const next = pendingRef.current[0];
        try {
          savedRef.current = await api<Settings>('/api/settings', { method: 'PUT', json: next });
        } catch (e) {
          toast(e instanceof Error ? e.message : '설정을 저장하지 못했습니다', { tone: 'error' });
        }
        pendingRef.current.shift();
        update();
      }
      savingRef.current = false;
    })();
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
    <div ref={wrapRef} className="relative inline-flex items-center rounded-full border border-line bg-raised">
      <span className="pl-2 text-[12px] font-medium text-fg-muted">{engineLabel(engine)}</span>
      <EffortControl label="빠른 작업" value={profiles.quickEffort} levels={levelsOf(profiles.quickModel)} onChange={(v) => selectEffort('quick', v)} />
      <button
        ref={pillRef}
        className="no-drag max-w-[100px] truncate rounded-lg py-1 text-[12px] font-medium text-fg hover:bg-hover"
        aria-label={`빠른 작업 모델: ${quickLabel} · 모델 선택`}
        aria-haspopup="dialog"
        aria-expanded={open && expanded === 'quick'}
        title={`빠른 작업: ${quickLabel} · ${effortLabel(profiles.quickEffort)}`}
        onClick={() => { openedFromRef.current = 'quick'; setExpanded('quick'); setOpen((o) => !(o && expanded === 'quick')); }}
      >{quickLabel}</button>
      <span aria-hidden="true" className="px-1 text-fg-dim">·</span>
      <EffortControl label="깊은 작업" value={profiles.heavyEffort} levels={levelsOf(profiles.heavyModel)} onChange={(v) => selectEffort('heavy', v)} />
      <button
        ref={heavyPillRef}
        className="no-drag inline-flex max-w-[120px] items-center gap-1 rounded-lg py-1 pr-2 text-[12px] font-medium text-fg hover:bg-hover"
        aria-label={`깊은 작업 모델: ${heavyLabel} · 모델 선택`}
        aria-haspopup="dialog"
        aria-expanded={open && expanded === 'heavy'}
        title={`깊은 작업: ${heavyLabel} · ${effortLabel(profiles.heavyEffort)}`}
        onClick={() => { openedFromRef.current = 'heavy'; setExpanded('heavy'); setOpen((o) => !(o && expanded === 'heavy')); }}
      >
        <span className="truncate">{heavyLabel}</span>
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
          <p className="px-3 pt-1 text-[11.5px] text-fg-dim">대화·설명 카드는 기본적으로 빠른 작업 모델을 사용하며, 대화에서 별도로 선택한 모델이 있으면 그 설정을 따릅니다.</p>
          <p className="px-3 pt-1 text-[11.5px] text-fg-dim">퀴즈의 새 문제 생성은 깊은 작업 모델을 사용합니다. 보기 선택·정답 확인·다시 풀기와 논문 목록 내보내기는 AI를 호출하지 않습니다.</p>
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
