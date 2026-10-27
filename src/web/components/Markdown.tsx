import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { linkPageCites, parsePageHref } from '../../shared/cite';
import { normalizeMath } from '../markdown-math';
import { remarkMark } from '../markdown-mark';
import { SourceChip } from './SourceChip';

export function PageChip({ page, label, onJump }: { page: number; label?: string; onJump(n: number): void }) {
  return (
    <button
      type="button"
      className="mx-0.5 inline-flex items-center rounded bg-accent-soft px-1.5 py-0 align-baseline text-[11.5px] font-medium text-accent ring-1 ring-accent/30 transition-colors duration-150 hover:bg-accent/20"
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

const remarkPlugins = [remarkGfm, remarkMath, remarkMark];
const rehypePlugins = [rehypeKatex];

function MarkdownImpl({ text, className }: { text: string; className?: string }) {
  const components: Components = {
    a({ href, children }) {
      if (href?.startsWith('#p-')) {
        const source = parsePageHref(href);
        return source ? <SourceChip {...source} label={String(children)} /> : <span>{children}</span>;
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
        {linkPageCites(normalizeMath(text))}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
