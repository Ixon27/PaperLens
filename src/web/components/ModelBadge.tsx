import type { MadeBy, ModelCatalog } from '../../shared/models';
import { effortLabel, engineLabel } from '../labels';
import { useModelCatalog } from '../state/models';
import { modelLabel } from './ModelChooser';

/** `Claude · Sonnet 4.5 · 높음`; rows from before model tracking show only the engine. */
export function formatMadeBy(by: MadeBy, catalog: ModelCatalog | null): string {
  const parts = [engineLabel(by.engine)];
  if (by.model !== undefined) {
    const label = modelLabel(by.engine, catalog, by.model);
    if (label) parts.push(label);
  }
  if (by.effort) parts.push(effortLabel(by.effort));
  return parts.join(' · ');
}

/** Which model produced a result. */
export function ModelBadge({ by }: { by: MadeBy | null }) {
  const { catalog } = useModelCatalog();
  if (!by) return null;
  const text = formatMadeBy(by, catalog);
  return (
    <span className="truncate text-[11px] text-fg-dim" title={text}>
      {text}
    </span>
  );
}
