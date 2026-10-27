import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { ArtifactDto } from '../types';

/** `undefined` while loading, `null` when the paper has none yet. */
export function useArtifact(paperId: string, kind: string) {
  const [artifact, setArtifact] = useState<ArtifactDto | null | undefined>(undefined);
  const load = useCallback(async () => {
    try {
      setArtifact(await api<ArtifactDto>(`/api/papers/${paperId}/artifacts/${kind}`));
    } catch {
      setArtifact(null);
    }
  }, [paperId, kind]);
  useEffect(() => {
    setArtifact(undefined);
    void load();
  }, [load]);
  return { artifact, load };
}
