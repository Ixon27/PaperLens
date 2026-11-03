import type { MadeBy } from '../../shared/models';
import { effortLabel, engineLabel } from '../labels';

/** Stored CLI request settings, never a measurement of the model's internal reasoning. */
export function formatMadeBy(by: MadeBy): string {
  const parts = [engineLabel(by.engine)];
  if (by.model !== undefined) {
    // A current catalog can resolve an old saved alias to a newer version; never relabel history.
    const label = by.model || (by.engine === 'codex' ? 'CLI 기본 모델' : '');
    if (label) parts.push(label);
  }
  if (by.effort !== undefined) parts.push(by.effort ? `요청 effort ${effortLabel(by.effort)}` : 'effort 미지정 (CLI 기본값)');
  return parts.join(' · ');
}

/** Which model produced a result. */
export function ModelBadge({ by }: { by: MadeBy | null }) {
  if (!by) return null;
  const text = formatMadeBy(by);
  return (
    <span className="truncate text-[11px] text-fg-dim" title={`${text} · 실제 내부 추론량은 알 수 없습니다`}>
      {text}
    </span>
  );
}
