import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { useViewer } from '../state/viewer';

/** `[p.3]` / `[p.3–4]` → link `#p-3` rendered as a page-jump chip. */
export function linkPages(text: string): string {
  return text.replace(/\[p\.(\d+)(?:[–-](\d+))?\]/g, (_m, a: string, b?: string) => `[p.${a}${b ? '–' + b : ''}](#p-${a})`);
}

export function PageChip({ page, label, onJump }: { page: number; label?: string; onJump(n: number): void }) {
  return (
    <button
      type="button"
      className="mx-0.5 inline-flex items-center rounded bg-blue-50 px-1.5 py-0 align-baseline text-[11.5px] font-medium text-blue-700 ring-1 ring-blue-200 hover:bg-blue-100"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onJump(page);
      }}
      title={`${page}쪽으로 이동`}
    >
      {label ?? `p.${page}`}
    </button>
  );
}

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex];

function MarkdownImpl({ text, className }: { text: string; className?: string }) {
  const { jumpToPage } = useViewer();
  const components: Components = {
    a({ href, children }) {
      if (href?.startsWith('#p-')) {
        const n = parseInt(href.slice(3), 10);
        return <PageChip page={n} label={String(children)} onJump={jumpToPage} />;
      }
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
  };
  return (
    <div className={`md ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {linkPages(text)}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
