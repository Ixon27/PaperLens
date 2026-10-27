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

/** Who produced a stored result. model/effort are absent on rows made before model tracking. */
export interface MadeBy {
  engine: EngineId;
  model?: string;
  effort?: string;
}
