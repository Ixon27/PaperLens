import { useEffect, useRef, useState } from 'react';
import { usePdfHighlighterContext, type GhostHighlight, type PdfSelection } from 'react-pdf-highlighter-extended';
import { postSse } from '../api';
import { ModelBadge } from '../components/ModelBadge';
import { TermCard } from '../components/TermCard';
import { usePaper } from '../state/paper';
import { useViewer } from '../state/viewer';
import { HIGHLIGHT_COLORS, HIGHLIGHT_NAMES, type HighlightColor, type HighlightPosition } from '../types';
import type { MadeBy } from '../../shared/models';

type Mode = 'menu' | 'translate' | 'term' | 'ask' | 'memo';

/** Longest selection offered as a vocabulary term. */
const TERM_MAX = 80;

const btn = 'rounded-lg px-2 py-1 text-[12.5px] font-medium text-fg hover:bg-hover active:scale-[0.97] transition-[transform,background-color] duration-150';

/** Tip shown for a fresh text or area selection. Mounted anew for each selection. */
export function SelectionTip() {
  const { getCurrentSelection, removeGhostHighlight, setTip, updateTipPosition } = usePdfHighlighterContext();
  const { paper, createHighlight } = usePaper();
  const { requestAsk } = useViewer();
  // The lib clears its selection once a ghost highlight is made, so capture it at mount.
  const [selection] = useState<PdfSelection | null>(() => getCurrentSelection());
  const ghostRef = useRef<GhostHighlight | null>(null);
  const [mode, setMode] = useState<Mode>('menu');
  const [translation, setTranslation] = useState('');
  const [translating, setTranslating] = useState(false);
  const [translatedBy, setTranslatedBy] = useState<MadeBy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [note, setNote] = useState('');
  const [memoColor, setMemoColor] = useState<HighlightColor>('yellow');
  const abortRef = useRef<AbortController | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // Keep the tip placed correctly as its content grows.
  useEffect(() => {
    if (!boxRef.current) return;
    const ro = new ResizeObserver(() => updateTipPosition());
    ro.observe(boxRef.current);
    return () => ro.disconnect();
  }, [updateTipPosition]);

  useEffect(() => () => abortRef.current?.abort(), []);

  if (!selection) return null;
  const isArea = Boolean(selection.content.image) && selection.type === 'area';
  const text = selection.content.text ?? '';
  const page = selection.position.boundingRect.pageNumber;

  const ghost = () => {
    if (!ghostRef.current) ghostRef.current = selection.makeGhostHighlight();
    return ghostRef.current;
  };
  const close = () => {
    abortRef.current?.abort();
    removeGhostHighlight();
    setTip(null);
  };

  const saveHighlight = async (color: HighlightColor, withNote?: string) => {
    const g = ghost();
    try {
      await createHighlight({
        type: isArea ? 'area' : 'text',
        color,
        position: g.position as HighlightPosition,
        text: isArea ? null : text,
        imageDataUrl: isArea ? (g.content.image ?? null) : null,
        note: withNote ?? null,
      });
      close();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const translate = async () => {
    ghost();
    setMode('translate');
    setTranslation('');
    setError(null);
    setTranslating(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await postSse(
        `/api/papers/${paper.id}/translate-selection`,
        { text, page },
        {
          signal: ac.signal,
          onEvent: (event, data) => {
            if (event === 'delta') setTranslation((t) => t + (data as { text: string }).text);
            else if (event === 'done') {
              const done = data as { text: string; by: MadeBy };
              setTranslation(done.text);
              setTranslatedBy(done.by);
            } else if (event === 'error') setError((data as { message: string }).message);
          },
        },
      );
    } catch (e) {
      if (!ac.signal.aborted) setError((e as Error).message);
    } finally {
      setTranslating(false);
    }
  };

  const explain = () => {
    ghost(); // for areas this also clears the drag rectangle
    if (isArea) requestAsk({ action: 'figure', imageDataUrl: selection.content.image, page });
    else requestAsk({ action: 'explain', quote: text, page });
    close();
  };

  const ask = () => {
    if (!question.trim()) return;
    requestAsk({ action: 'ask', quote: text, page, question: question.trim() });
    close();
  };

  const colorDots = (onPick: (c: HighlightColor) => void, active?: HighlightColor) => (
    <div className="flex items-center gap-1 px-1">
      {(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((c) => (
        <button
          key={c}
          title={`${HIGHLIGHT_NAMES[c]} 하이라이트`}
          aria-label={`${HIGHLIGHT_NAMES[c]} 하이라이트`}
          className={`h-4 w-4 rounded-full ring-1 ring-fg/15 transition-transform duration-150 hover:scale-110 ${active === c ? 'ring-2 ring-fg' : ''}`}
          style={{ background: HIGHLIGHT_COLORS[c] }}
          onClick={() => onPick(c)}
        />
      ))}
    </div>
  );

  return (
    <div
      ref={boxRef}
      className="pr-tip max-w-[420px] rounded-xl border border-line bg-raised p-1 shadow-pop"
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
    >
      {mode === 'menu' && (
        <div className="flex items-center gap-0.5">
          {!isArea && (
            <button className={btn} onClick={() => void translate()}>
              번역
            </button>
          )}
          <button className={btn} onClick={explain}>
            설명
          </button>
          {!isArea && text.trim().length <= TERM_MAX && (
            <button
              className={btn}
              onClick={() => {
                ghost();
                setMode('term');
              }}
            >
              용어
            </button>
          )}
          {!isArea && (
            <button
              className={btn}
              onClick={() => {
                ghost();
                setMode('ask');
              }}
            >
              질문
            </button>
          )}
          <div className="mx-0.5 h-4 w-px bg-line" />
          {colorDots((c) => void saveHighlight(c))}
          <div className="mx-0.5 h-4 w-px bg-line" />
          <button
            className={btn}
            onClick={() => {
              ghost();
              setMode('memo');
            }}
          >
            메모
          </button>
        </div>
      )}

      {mode === 'translate' && (
        <div className="w-[400px] p-2">
          <div className="max-h-[260px] overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed text-fg">
            {translation || (translating ? <span className="text-fg-dim">번역 중…</span> : null)}
          </div>
          {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
          <div className="mt-2 flex items-center justify-end gap-1">
            <span className="mr-auto min-w-0 truncate">
              <ModelBadge by={translatedBy} />
            </span>
            <button className={btn} disabled={!translation} onClick={() => void navigator.clipboard.writeText(translation)}>
              복사
            </button>
            <button className={btn} onClick={close}>
              닫기
            </button>
          </div>
        </div>
      )}

      {mode === 'term' && <TermCard paperId={paper.id} term={text.trim()} page={page} />}

      {mode === 'ask' && (
        <div className="w-[380px] p-1.5">
          <input
            autoFocus
            className="w-full rounded-md border border-line-strong bg-sunken px-2 py-1.5 text-[13px] text-fg outline-none transition-[border-color] duration-150 placeholder:text-fg-dim focus:border-focus"
            placeholder="이 부분에 대해 질문… (Enter)"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) ask();
            }}
          />
        </div>
      )}

      {mode === 'memo' && (
        <div className="w-[340px] p-1.5">
          <textarea
            autoFocus
            className="h-20 w-full resize-none rounded-md border border-line-strong bg-sunken px-2 py-1.5 text-[13px] text-fg outline-none transition-[border-color] duration-150 placeholder:text-fg-dim focus:border-focus"
            placeholder="메모"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="mt-1 flex items-center justify-between">
            {colorDots(setMemoColor, memoColor)}
            <div className="flex gap-1">
              <button className={btn} onClick={close}>
                취소
              </button>
              <button className="rounded-lg bg-accent px-2.5 py-1 text-[12.5px] font-medium text-accent-fg transition-[transform,opacity] duration-150 hover:opacity-90 active:scale-[0.97]" onClick={() => void saveHighlight(memoColor, note.trim() || undefined)}>
                저장
              </button>
            </div>
          </div>
          {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
        </div>
      )}
      {mode === 'menu' && error && <div className="px-2 pb-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
