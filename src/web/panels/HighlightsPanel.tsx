import { useMemo, useState } from 'react';
import { useToast } from '../components/Toast';
import { toAppHighlight } from '../pdf/PdfPane';
import { ALT_KEY } from '../labels';
import { usePaper } from '../state/paper';
import { useViewer } from '../state/viewer';
import { HIGHLIGHT_COLORS, HIGHLIGHT_NAMES, type HighlightColor, type HighlightDto } from '../types';

export function HighlightsPanel() {
  const { highlights } = usePaper();
  const sorted = useMemo(
    () =>
      [...highlights].sort(
        (a, b) => a.position.boundingRect.pageNumber - b.position.boundingRect.pageNumber || a.position.boundingRect.y1 / a.position.boundingRect.height - b.position.boundingRect.y1 / b.position.boundingRect.height,
      ),
    [highlights],
  );
  const groups = useMemo(() => {
    const map = new Map<number, HighlightDto[]>();
    for (const h of sorted) {
      const p = h.position.boundingRect.pageNumber;
      map.set(p, [...(map.get(p) ?? []), h]);
    }
    return [...map.entries()];
  }, [sorted]);

  if (!highlights.length) {
    return <div className="p-6 text-[13px] text-fg-muted">PDF에서 글을 선택하거나 {ALT_KEY} 드래그로 영역을 고른 뒤 색을 누르면 하이라이트가 저장됩니다.</div>;
  }
  return (
    <div className="p-3">
      {groups.map(([page, list]) => (
        <section key={page} className="mb-4">
          <h3 className="mb-1.5 text-[12px] font-bold text-fg-muted">p.{page}</h3>
          <ul className="flex flex-col gap-2">
            {list.map((h) => (
              <HighlightItem key={h.id} h={h} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function HighlightItem({ h }: { h: HighlightDto }) {
  const { updateHighlight, deleteHighlight } = usePaper();
  const { utilsRef } = useViewer();
  const [note, setNote] = useState(h.note ?? '');
  const toast = useToast();
  const fail = (e: unknown) => toast((e as Error).message, { tone: 'error' });

  return (
    <li className="group rounded-md border border-line bg-surface p-2">
      <button className="flex w-full items-start gap-2 text-left" onClick={() => utilsRef.current?.scrollToHighlight(toAppHighlight(h))} title="PDF에서 보기">
        <span className="mt-1 h-3 w-3 shrink-0 rounded-full ring-1 ring-fg/15" style={{ background: HIGHLIGHT_COLORS[h.color] }} />
        {h.type === 'area' && h.imageUrl ? (
          <img src={h.imageUrl} alt="영역 하이라이트" className="max-h-40 max-w-full rounded border border-line" />
        ) : (
          <span className="line-clamp-4 text-[13px] leading-snug text-fg">{h.text}</span>
        )}
      </button>
      <textarea
        className="mt-1.5 w-full resize-y rounded border border-transparent bg-sunken px-2 py-1 text-[12.5px] text-fg outline-none focus:border-line-strong focus:bg-surface"
        rows={note ? 2 : 1}
        placeholder="메모 추가…"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => {
          if ((h.note ?? '') !== note.trim()) void updateHighlight(h.id, { note: note.trim() || null }).catch(fail);
        }}
      />
      <div className="mt-1 flex items-center gap-1">
        {(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((c) => (
          <button
            key={c}
            aria-label={`${HIGHLIGHT_NAMES[c]}으로 바꾸기`}
            className={`h-3.5 w-3.5 rounded-full ring-1 ring-fg/15 ${h.color === c ? 'ring-2 ring-inverse' : 'opacity-60 hover:opacity-100'}`}
            style={{ background: HIGHLIGHT_COLORS[c] }}
            onClick={() => void updateHighlight(h.id, { color: c }).catch(fail)}
          />
        ))}
        <button
          className="ml-auto rounded px-1.5 text-[12px] text-fg-dim hover:bg-danger-soft hover:text-danger"
          onClick={() => {
            if (confirm('이 하이라이트를 지울까요?')) void deleteHighlight(h.id).catch(fail);
          }}
        >
          삭제
        </button>
      </div>
    </li>
  );
}
