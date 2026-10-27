import { useEffect, useState } from 'react';
import { api } from '../api';
import { useViewer } from '../state/viewer';
import type { TermDto } from '../types';
import { smallGhostBtnCls } from './Dialog';
import { ModelBadge } from './ModelBadge';

/** Looks the term up (saving it to the paper's 키워드 사전) and shows the explanation. */
export function TermCard({ paperId, term, page }: { paperId: string; term: string; page: number | null }) {
  const { showKeywords, bumpTerms } = useViewer();
  const [entry, setEntry] = useState<TermDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setEntry(null);
    setError(null);
    api<TermDto>(`/api/papers/${paperId}/terms`, { method: 'POST', json: { term, page } })
      .then((t) => {
        if (!alive) return;
        setEntry(t);
        bumpTerms();
      })
      .catch((e: unknown) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [paperId, term, page, bumpTerms]);

  return (
    <div className="w-[340px] p-3">
      {error ? (
        <p className="text-[12.5px] text-danger">{error}</p>
      ) : !entry ? (
        <div className="flex items-center gap-2 text-[12.5px] text-fg-muted">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
          설명 찾는 중…
        </div>
      ) : (
        <>
          <div>
            <span className="text-[14px] font-semibold text-fg">{entry.term}</span>
            {entry.ko !== entry.term && <span className="ml-1.5 text-[13px] text-accent">{entry.ko}</span>}
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-fg">{entry.definition}</p>
          {entry.inPaper && (
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-muted">
              <span className="font-medium">이 논문에서</span> {entry.inPaper}
            </p>
          )}
          <div className="mt-2 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate">
              <ModelBadge by={entry.by} />
            </span>
            <button className={smallGhostBtnCls} onClick={showKeywords}>
              키워드 사전에서 보기
            </button>
          </div>
        </>
      )}
    </div>
  );
}
