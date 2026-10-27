import { useMemo, useRef, useState } from 'react';
import { ChevronDown, Copy } from 'lucide-react';
import { iconBtnCls } from './Dialog';
import { Markdown } from './Markdown';
import { useCopy } from './Toast';

export interface Section {
  /** null: text before the first `####` heading. */
  title: string | null;
  body: string;
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^####\s+(.+)$/;

/** Split markdown at `####` headings outside code fences. */
export function splitSections(md: string): Section[] {
  const sections: Section[] = [];
  let title: string | null = null;
  let body: string[] = [];
  let fence = false;
  const flush = () => {
    const text = body.join('\n').trim();
    if (title !== null || text) sections.push({ title, body: text });
  };
  for (const line of md.split('\n')) {
    if (FENCE.test(line)) fence = !fence;
    const m = fence ? null : HEADING.exec(line);
    if (m) {
      flush();
      title = m[1].replace(/\s+#+\s*$/, '').replace(/[*_`]/g, '').trim();
      body = [];
    } else body.push(line);
  }
  flush();
  return sections;
}

/** `####` sections as collapsible cards, with an optional sticky chip row to jump between them. */
export function SectionedMarkdown({ text, nav }: { text: string; nav?: boolean }) {
  const sections = useMemo(() => splitSections(text), [text]);
  const [closed, setClosed] = useState<Set<number>>(() => new Set());
  const cardRefs = useRef<(HTMLElement | null)[]>([]);
  const copy = useCopy();

  const setOpen = (i: number, open: boolean) =>
    setClosed((s) => {
      const next = new Set(s);
      if (open) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div className="flex flex-col gap-3">
      {nav && sections.some((s) => s.title) && (
        <div className="sticky top-0 z-10 -mx-1 flex gap-1.5 overflow-x-auto bg-surface/85 px-1 py-2 backdrop-blur-md">
          {sections.map((s, i) =>
            s.title ? (
              <button
                key={i}
                className="h-7 shrink-0 rounded-full border border-line px-2.5 text-[12px] text-fg-muted transition-colors duration-150 hover:bg-hover hover:text-fg"
                onClick={() => {
                  setOpen(i, true);
                  cardRefs.current[i]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                }}
              >
                {s.title}
              </button>
            ) : null,
          )}
        </div>
      )}
      {sections.map((s, i) => {
        if (s.title === null) return <Markdown key={i} text={s.body} />;
        const title = s.title;
        const open = !closed.has(i);
        return (
          <section
            key={i}
            ref={(el) => {
              cardRefs.current[i] = el;
            }}
            className="scroll-mt-14 rounded-xl border border-line bg-surface"
          >
            <div className="flex items-center gap-1 pr-2">
              <button
                className="flex min-w-0 flex-1 items-center gap-2 px-4 py-3 text-left"
                aria-expanded={open}
                onClick={() => setOpen(i, !open)}
              >
                <ChevronDown size={14} className={`shrink-0 text-fg-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                <span className="text-[14.5px] font-semibold text-fg">{title}</span>
              </button>
              <button className={iconBtnCls} aria-label={`${title} 복사`} title="복사" onClick={() => copy(s.body)}>
                <Copy size={14} />
              </button>
            </div>
            <div className="pr-accordion" data-open={open || undefined}>
              <div
                ref={(el) => {
                  if (el) el.inert = !open;
                }}
              >
                <div className="px-4 pb-4">
                  <Markdown text={s.body} />
                </div>
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
