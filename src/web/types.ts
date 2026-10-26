export interface Author {
  family: string;
  given?: string;
}

export type JobKind = 'import' | 'translation' | 'analysis' | 'mindmap' | 'references';
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
  researchTypes: string[] | null;
  status: PaperStatus;
  job: JobDto | null;
  abstract?: string | null;
}

export interface BlockDto {
  idx: number;
  page: number;
  text: string;
  /** [xMin, yMin, xMax, yMax] in PDF points, top-left origin */
  lines: [number, number, number, number][];
  pageW: number;
  pageH: number;
  isRef: boolean;
  translatable: boolean;
  ko: string | null;
}

export interface ArtifactDto<T = string> {
  content: T;
  meta: Record<string, unknown>;
  engine: string | null;
  updatedAt: string;
}

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';

export const HIGHLIGHT_COLORS: Record<HighlightColor, string> = {
  yellow: '#fde047',
  green: '#86efac',
  blue: '#93c5fd',
  pink: '#f9a8d4',
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
  claude: { quickModel: string; heavyModel: string };
  codex: { model: string; quickEffort: string; heavyEffort: string };
  readerContext: string;
}

export type ResearchType = 'wetlab' | 'omics' | 'review' | 'clinical';

export const RESEARCH_TYPE_LABELS: Record<ResearchType, string> = {
  wetlab: '실험실 측정(wet-lab)',
  omics: '오믹스·계산·생물정보',
  review: '리뷰·메타분석',
  clinical: '임상·코호트·역학',
};

export interface AskInput {
  action: 'ask' | 'explain' | 'figure';
  question?: string;
  quote?: string;
  page?: number;
  imageDataUrl?: string;
}
