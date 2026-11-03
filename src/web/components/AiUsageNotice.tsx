import { useEffect, useState } from 'react';
import { catalogModel, preferredEffort, resolveEffort } from '../../shared/models';
import { api } from '../api';
import { engineLabel } from '../labels';
import { useModelCatalog } from '../state/models';
import type { Settings } from '../types';

/** Planned requests, not a token/cost estimate or a claim about hidden reasoning. */
export function AiUsageNotice({ profile, requests, detail }: { profile: 'quick' | 'heavy'; requests?: number; detail?: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const { catalog } = useModelCatalog();
  useEffect(() => {
    let disposed = false;
    void api<Settings>('/api/settings').then((s) => { if (!disposed) setSettings(s); }).catch(() => {});
    const changed = (event: Event) => setSettings((event as CustomEvent<Settings>).detail);
    window.addEventListener('paperlens-model-settings', changed);
    return () => { disposed = true; window.removeEventListener('paperlens-model-settings', changed); };
  }, []);
  const engine = settings?.engine;
  const selected = engine && settings ? settings[engine] : null;
  const value = selected ? profile === 'quick' ? selected.quickModel : selected.heavyModel : '';
  const choice = engine ? catalogModel(engine, catalog?.[engine].models ?? [], value) : undefined;
  const requested = selected ? preferredEffort(profile === 'quick' ? selected.quickEffort : selected.heavyEffort, profile) : '';
  const effort = resolveEffort(requested, choice);
  return <aside aria-label="AI 실행 안내" className="rounded-lg border border-line bg-sunken/50 px-3 py-2 text-[12px] leading-relaxed text-fg-muted">
    <p className="font-medium text-fg">{profile === 'heavy' ? '깊은 작업' : '빠른 작업'} · {engine ? `${engineLabel(engine)} · ${choice?.label ?? (value || 'CLI 기본 모델')} · effort ${effort || (choice ? '설정 미지원 또는 기본값 미제공' : '지원 정보 확인 필요')}` : '모델 설정 확인 중'}</p>
    <p>{requests !== undefined ? `새 생성 기본 ${requests}회 요청. ` : ''}{detail} 응답 형식 보정 등으로 추가 요청이 발생할 수 있습니다. 실제 사용량은 논문 길이·모델에 따라 달라지며, 잔여 한도·비용 예측이 아닙니다.</p>
  </aside>;
}
