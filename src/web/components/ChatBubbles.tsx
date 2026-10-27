import { Copy } from 'lucide-react';
import type { ChatItem } from '../types';
import { smallIconBtnCls } from './Dialog';
import { Markdown, PageChip } from './Markdown';
import { ModelBadge } from './ModelBadge';
import { useCopy } from './Toast';

export function UserBubble({ m, onJump }: { m: ChatItem; onJump(n: number): void }) {
  return (
    <li className="max-w-[85%] self-end rounded-2xl bg-inverse px-3.5 py-2 text-[13.5px] text-inverse-fg">
      {m.quote && <div className="mb-1.5 line-clamp-4 whitespace-pre-wrap text-[12.5px] opacity-75">{m.quote}</div>}
      {m.imageUrl && <img src={m.imageUrl} alt="첨부 그림" className="mb-1.5 max-h-40 max-w-full rounded-lg bg-surface" />}
      <div className="whitespace-pre-wrap">
        {m.content}
        {m.page !== null && <PageChip page={m.page} onJump={onJump} />}
      </div>
    </li>
  );
}

export function AssistantBubble({ m }: { m: ChatItem }) {
  const copy = useCopy();
  return (
    <li className="text-[14px] text-fg">
      {m.content ? <Markdown text={m.content} /> : m.streaming && <div className="animate-pulse text-fg-dim">생성 중…</div>}
      {m.error && <div className="mt-1 text-[12.5px] text-danger">{m.error}</div>}
      {m.content && !m.streaming && (
        <div className="mt-1 flex items-center gap-1">
          <button className={smallIconBtnCls} aria-label="답변 복사" title="복사" onClick={() => copy(m.content)}>
            <Copy size={13} />
          </button>
          <span className="ml-auto min-w-0">
            <ModelBadge by={m.by} />
          </span>
        </div>
      )}
    </li>
  );
}

export function ChatBubble({ m, onJump }: { m: ChatItem; onJump(n: number): void }) {
  return m.role === 'user' ? <UserBubble m={m} onJump={onJump} /> : <AssistantBubble m={m} />;
}
