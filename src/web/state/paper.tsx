import { createContext, useCallback, useContext, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { api } from '../api';
import type { BlockDto, HighlightColor, HighlightDto, HighlightPosition, PaperDto } from '../types';

export interface NewHighlight {
  type: 'text' | 'area';
  color: HighlightColor;
  position: HighlightPosition;
  text?: string | null;
  imageDataUrl?: string | null;
  note?: string | null;
}

export interface HighlightPatch {
  color?: HighlightColor;
  note?: string | null;
  position?: HighlightPosition;
  imageDataUrl?: string;
}

export interface PaperState {
  paper: PaperDto;
  reloadPaper(): Promise<void>;
  /** null while loading */
  blocks: BlockDto[] | null;
  reloadBlocks(): Promise<void>;
  setBlocks: Dispatch<SetStateAction<BlockDto[] | null>>;
  /** True when the PDF exists but has no text layer (scanned) → AI features unavailable. */
  noText: boolean;
  highlights: HighlightDto[];
  createHighlight(h: NewHighlight): Promise<HighlightDto>;
  updateHighlight(id: string, patch: HighlightPatch): Promise<void>;
  deleteHighlight(id: string): Promise<void>;
}

const PaperContext = createContext<PaperState | null>(null);

export function PaperProvider({ paper, reloadPaper, children }: { paper: PaperDto; reloadPaper(): Promise<void>; children: ReactNode }) {
  const [blocks, setBlocks] = useState<BlockDto[] | null>(null);
  const [highlights, setHighlights] = useState<HighlightDto[]>([]);
  const id = paper.id;

  const reloadBlocks = useCallback(async () => {
    setBlocks(await api<BlockDto[]>(`/api/papers/${id}/blocks`));
  }, [id]);

  useEffect(() => {
    setBlocks(null);
    void reloadBlocks();
    void api<HighlightDto[]>(`/api/papers/${id}/highlights`).then(setHighlights);
  }, [id, reloadBlocks]);

  // Blocks appear once a PDF gets attached/extracted.
  const blockCount = paper.status.blockCount;
  useEffect(() => {
    if (blocks && blocks.length !== blockCount) void reloadBlocks();
  }, [blockCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const createHighlight = useCallback(
    async (h: NewHighlight) => {
      const created = await api<HighlightDto>(`/api/papers/${id}/highlights`, { method: 'POST', json: h });
      setHighlights((list) => [...list, created]);
      return created;
    },
    [id],
  );

  const updateHighlight = useCallback(async (hid: string, patch: HighlightPatch) => {
    const updated = await api<HighlightDto>(`/api/highlights/${hid}`, { method: 'PATCH', json: patch });
    setHighlights((list) => list.map((h) => (h.id === hid ? updated : h)));
  }, []);

  const deleteHighlight = useCallback(async (hid: string) => {
    await api(`/api/highlights/${hid}`, { method: 'DELETE' });
    setHighlights((list) => list.filter((h) => h.id !== hid));
  }, []);

  const value = useMemo<PaperState>(
    () => ({
      paper,
      reloadPaper,
      blocks,
      reloadBlocks,
      setBlocks,
      noText: paper.hasPdf && paper.status.blockCount === 0 && !paper.job,
      highlights,
      createHighlight,
      updateHighlight,
      deleteHighlight,
    }),
    [paper, reloadPaper, blocks, reloadBlocks, highlights, createHighlight, updateHighlight, deleteHighlight],
  );
  return <PaperContext.Provider value={value}>{children}</PaperContext.Provider>;
}

export function usePaper(): PaperState {
  const v = useContext(PaperContext);
  if (!v) throw new Error('usePaper must be used inside PaperProvider');
  return v;
}
