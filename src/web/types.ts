import type { ExplainAnchor } from '../shared/explain';
import type { MadeBy, ModelSpec } from '../shared/models';
import type { FieldId } from '../shared/fields';

export interface Author {
  family: string;
  given?: string;
}

export type JobKind = 'import' | 'translation' | 'analysis' | 'addons' | 'summary' | 'mindmap' | 'references' | 'keywords' | 'figure' | 'lineage';
export type JobStatus = 'queued' | 'running' | 'done' | 'error';

export interface JobDto {
  id: string;
  kind: JobKind;
  status: JobStatus;
  progress: number;
  message: string | null;
  error: string | null;
}

export interface PaperStatus {
  analysis: boolean;
  mindmap: boolean;
  translation: { done: number; total: number };
  blockCount: number;
}

export interface PaperDto {
  id: string;
  title: string;
  authors: Author[];
  year: number | null;
  journal: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  doi: string | null;
  arxivId: string | null;
  openalexId: string | null;
  hasPdf: boolean;
  pageCount: number | null;
  field: FieldId | null;
  fieldSuggested: FieldId | null;
  createdAt: string;
  /** null until the paper is first opened. */
  lastOpenedAt: string | null;
  status: PaperStatus;
  job: JobDto | null;
  abstract?: string | null;
}

/** `GET /api/sync/status` */
export interface SyncStatusDto {
  available: boolean;
  configured: boolean;
  connected: boolean;
  email: string | null;
  syncing: boolean;
  loginPending: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  conflicts: number;
  devices: number;
  changedAt: string | null;
}

/** One translated sentence and the source characters `text[start, end)` it translates. */
export interface KoSentence {
  start: number;
  end: number;
  ko: string;
}

export interface BlockDto {
  idx: number;
  page: number;
  text: string;
  /** [xMin, yMin, xMax, yMax] in PDF points, top-left origin; a 5th entry is the page when the paragraph continues there. */
  lines: [number, number, number, number, number?][];
  pageW: number;
  pageH: number;
  isRef: boolean;
  kind: 'body' | 'heading' | 'caption' | 'aside';
  translatable: boolean;
  /** [page, text-layer item index, start, end]: which text-layer characters draw `text[start, end)`. Empty on old layouts. */
  spans: [number, number, number, number][];
  ko: string | null;
  /** Per-sentence translation; null when only the paragraph could be aligned (or it is untranslated). */
  koSentences: KoSentence[] | null;
  /** The model that translated this block. */
  by: MadeBy | null;
}

export interface ArtifactDto<T = string> {
  content: T;
  meta: Record<string, unknown>;
  by: MadeBy | null;
  updatedAt: string;
}

export type LineageRole = 'foundation' | 'method' | 'data' | 'prior' | 'contrast';
export interface LineageNodeDto {
  id: string;
  side: 'ancestor' | 'paper' | 'descendant';
  title: string;
  year: number | null;
  authors: string;
  venue: string | null;
  citedBy: number | null;
  doi: string | null;
  role: LineageRole | null;
  note: string;
  inLibrary: string | null;
}
export interface LineageDto {
  version: 1;
  source: 'openalex' | 'references';
  summary: string;
  nodes: LineageNodeDto[];
  edges: { from: string; to: string }[];
  strands: { label: string; ids: string[] }[];
}

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';

export const HIGHLIGHT_COLORS: Record<HighlightColor, string> = {
  yellow: '#fde047',
  green: '#86efac',
  blue: '#93c5fd',
  pink: '#f9a8d4',
};

export const HIGHLIGHT_NAMES: Record<HighlightColor, string> = {
  yellow: '노랑',
  green: '초록',
  blue: '파랑',
  pink: '분홍',
};

export interface ScaledRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  height: number;
  pageNumber: number;
}

export interface HighlightPosition {
  boundingRect: ScaledRect;
  rects: ScaledRect[];
  usePdfCoordinates?: boolean;
}

export interface HighlightDto {
  id: string;
  type: 'text' | 'area';
  color: HighlightColor;
  position: HighlightPosition;
  text: string | null;
  /** URL of the area snapshot (`/api/images/<file>`) or null */
  imageUrl: string | null;
  note: string | null;
  createdAt: string;
}

export interface Settings {
  engine: 'claude' | 'codex';
  claude: { quickModel: string; heavyModel: string; quickEffort: string; heavyEffort: string };
  codex: { quickModel: string; heavyModel: string; quickEffort: string; heavyEffort: string };
  readerContext: string;
  vaultPath: string | null;
  contactEmail: string;
  onboardingDone: boolean;
  updateCheck: boolean;
  dismissedUpdate: string;
}

/** `GET /api/update` */
export interface UpdateStatus {
  current: string;
  latest: string | null;
  url: string | null;
  available: boolean;
}

/** `GET /api/system` */
export interface SystemInfo {
  desktop: boolean;
  filesPath: string;
  dbPath: string;
  vaultPath: string | null;
  home: string;
  dataDir: string;
}


export interface AskInput {
  action: 'ask' | 'explain' | 'figure' | 'card';
  question?: string;
  quote?: string;
  page?: number;
  imageDataUrl?: string;
}

export interface ThreadDto {
  id: string;
  title: string;
  /** null follows the 빠른 작업 setting. */
  model: ModelSpec | null;
  /** `explain`: the follow-up chat of a PDF explanation card. */
  kind: 'chat' | 'explain';
  createdAt: string;
}

/** `GET /api/papers/:id/explanations`: a card thread and the PDF spot it explains. */
export interface ExplanationDto extends ThreadDto {
  anchor: ExplainAnchor;
  /** Has a saved AI answer (the marker turns accent). */
  answered: boolean;
}

export interface MessageDto {
  id: string;
  role: 'user' | 'assistant';
  action: AskInput['action'] | null;
  content: string;
  quote: string | null;
  page: number | null;
  imageUrl: string | null;
  by: MadeBy | null;
  createdAt: string;
}

/** A message in the list; the live assistant bubble carries `streaming`/`error`. */
export type ChatItem = MessageDto & { streaming?: boolean; error?: string };

/** A term in the paper's 키워드 사전: AI-picked (`auto`) or looked up by the reader (`lookup`). */
export interface TermDto {
  id: string;
  term: string;
  /** The Korean term researchers use (the original when it is usually written in English). */
  ko: string;
  definition: string;
  /** Its meaning or role in this paper; '' when the context did not say. */
  inPaper: string;
  page: number | null;
  by: MadeBy | null;
  createdAt: string;
  source: 'auto' | 'lookup';
}
