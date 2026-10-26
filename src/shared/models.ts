export interface ModelChoice {
  value: string;
  label: string;
  description: string;
  /** The version behind a CLI alias, when reported by the CLI. */
  resolvedModel?: string;
}

export interface EngineModels {
  models: ModelChoice[];
  error: string | null;
}

export interface ModelCatalog {
  claude: EngineModels;
  codex: EngineModels;
}
