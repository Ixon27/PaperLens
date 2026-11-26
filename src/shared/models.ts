export interface ModelChoice {
  value: string;
  label: string;
  description: string;
  /** The version behind a CLI alias, when reported by the CLI. */
  resolvedModel?: string;
  /** Effort levels the CLI accepts for this model; empty when it takes none. */
  efforts: string[];
  defaultEffort?: string;
  /** Codex: the model the CLI uses when none is given. */
  isDefault?: boolean;
}

export interface EngineModels {
  models: ModelChoice[];
  error: string | null;
  /** Local executable diagnostics only; never account or authentication output. `latest`: newest published release, null when unknown. */
  cli?: { path: string | null; version: string | null; latest?: string | null; source: 'path' | 'install-dir' | 'fallback' | null };
}

export interface ModelCatalog {
  claude: EngineModels;
  codex: EngineModels;
}

export type EngineId = 'claude' | 'codex';

/** A concrete model choice: Claude model must be non-empty; Codex '' = CLI default; effort '' = no flag. */
export interface ModelSpec {
  engine: EngineId;
  model: string;
  effort: string;
}

/** Requested CLI arguments, not measured internal reasoning. Missing fields predate model tracking. */
export interface MadeBy {
  engine: EngineId;
  model?: string;
  effort?: string;
}

export const profileEffort = (profile: 'quick' | 'heavy'): string => profile === 'quick' ? 'low' : 'high';

/** An empty legacy value is a profile preference, never an "auto" choice. */
export const preferredEffort = (value: string, profile: 'quick' | 'heavy'): string =>
  value && value !== 'auto' ? value : profileEffort(profile);

export function catalogModel(engine: EngineId, models: ModelChoice[], value: string): ModelChoice | undefined {
  return engine === 'codex' && value === '' ? models.find((model) => model.isDefault) : models.find((model) => model.value === value);
}

/** Only CLI-advertised levels can become arguments; unknown defaults must not be invented. */
export function resolveEffort(preferred: string, model?: ModelChoice): string {
  if (!model) return '';
  if (preferred && preferred !== 'auto' && model.efforts.includes(preferred)) return preferred;
  return model.defaultEffort && model.defaultEffort !== 'auto' && model.efforts.includes(model.defaultEffort) ? model.defaultEffort : '';
}

/** True only when both are plain x.y.z and the published release is newer; unknown or pre-release versions never warn. */
export function cliUpdateAvailable(current: string | null | undefined, latest: string | null | undefined): boolean {
  const parse = (v: string | null | undefined) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? '')?.slice(1).map(Number);
  const have = parse(current);
  const newest = parse(latest);
  if (!have || !newest) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== newest[i]) return newest[i] > have[i];
  return false;
}
