import { ArrowUp, Square } from 'lucide-react';
import { useState, type KeyboardEvent, type ReactNode } from 'react';

const ROUND_BTN =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-inverse text-inverse-fg transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.95] disabled:opacity-30';

/** Question box with a model chip (`picker`) and send/stop. Enter sends; Shift+Enter and IME composition do not. */
export function ChatComposer({
  busy,
  disabled = false,
  onSubmit,
  onStop,
  picker,
  placeholder,
  rows,
  className,
  textareaClassName,
}: {
  busy: boolean;
  /** Nothing to ask about yet (e.g. an explanation card without its answer). */
  disabled?: boolean;
  onSubmit(question: string): void;
  onStop(): void;
  picker: ReactNode;
  placeholder: string;
  rows: number;
  className: string;
  textareaClassName: string;
}) {
  const [input, setInput] = useState('');

  const submit = () => {
    const q = input.trim();
    if (!q || busy || disabled) return;
    setInput('');
    onSubmit(q);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    submit();
  };

  return (
    <div className={className}>
      <textarea
        className={`w-full resize-y bg-transparent py-1 text-[13px] text-fg outline-none placeholder:text-fg-dim disabled:opacity-60 ${textareaClassName}`}
        rows={rows}
        placeholder={placeholder}
        value={input}
        disabled={disabled}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="mt-1 flex items-center gap-2">
        {picker}
        {busy ? (
          <button className={`${ROUND_BTN} ml-auto`} aria-label="중지" title="중지" onClick={onStop}>
            <Square size={12} fill="currentColor" />
          </button>
        ) : (
          <button className={`${ROUND_BTN} ml-auto`} aria-label="보내기" title="보내기" disabled={disabled || !input.trim()} onClick={submit}>
            <ArrowUp size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
