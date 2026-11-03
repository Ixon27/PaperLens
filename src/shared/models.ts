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
  /** Local executable diagnostics only; never account or authentication output. */
  cli?: { path: string | null; version: string | null; source: 'path' | 'install-dir' | 'fallback' | null };
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
