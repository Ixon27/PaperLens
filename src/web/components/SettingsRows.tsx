import { useState, type ReactNode } from 'react';
import { displayPath, FILE_MANAGER } from '../labels';
import { inputCls, smallBtnCls, smallGhostBtnCls } from './Dialog';
import { useToast } from './Toast';

export function SettingsSection({ title, children, note, action }: { title: string; children: ReactNode; note?: ReactNode; action?: ReactNode }) {
  return (
    <section className="mt-6 first:mt-0">
      <div className="mb-2 flex min-h-5 items-center justify-between gap-2">
        <h3 className="text-[12px] font-semibold text-fg-muted">{title}</h3>
        {action}
      </div>
      <div className="divide-y divide-line rounded-xl border border-line bg-surface">{children}</div>
      {note && <p className="mt-2 text-[12px] leading-relaxed text-fg-dim">{note}</p>}
    </section>
  );
}

export function SettingsRow({
  label,
  labelFor,
  description,
  children,
  aside,
}: {
  label: string;
  /** id of the control in `children`, so the label focuses it. */
  labelFor?: string;
  description?: ReactNode;
  children?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <label htmlFor={labelFor} className="flex-1 text-[13px] font-medium text-fg">
          {label}
        </label>
        {aside}
      </div>
      {description && <p className="mt-0.5 text-[12px] leading-relaxed text-fg-muted">{description}</p>}
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}

/** Desktop: native folder chooser. Web: a plain path field. */
export function VaultPicker({
  value,
  onChange,
  disabled,
  home,
  onBusyChange,
}: {
  value: string | null;
  onChange(value: string | null): void;
  disabled?: boolean;
  home: string;
  onBusyChange?(busy: boolean): void;
}) {
  const [choosing, setChoosing] = useState(false);
  const toast = useToast();
  const desktop = window.paperReaderDesktop;
  if (!desktop) {
    return (
      <input
        className={inputCls}
        placeholder="/Users/이름/Obsidian/볼트"
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
      />
    );
  }
  const choose = async () => {
    setChoosing(true);
    onBusyChange?.(true);
    try {
      const path = await desktop.chooseDirectory();
      if (path !== null) onChange(path);
    } catch {
      toast('폴더를 선택하지 못했습니다', { tone: 'error' });
    } finally {
      setChoosing(false);
      onBusyChange?.(false);
    }
  };
  return (
    <div className="flex items-center gap-2">
      {value ? (
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg" title={value}>
          {displayPath(value, home)}
        </span>
      ) : (
        <span className="min-w-0 flex-1 text-[12.5px] text-fg-dim">연결 안 됨</span>
      )}
      <button className={`${smallBtnCls} shrink-0`} disabled={disabled || choosing} onClick={() => void choose()}>
        폴더 선택…
      </button>
      {value && (
        <button className={`${smallGhostBtnCls} shrink-0`} disabled={disabled || choosing} onClick={() => onChange(null)}>
          연결 해제
        </button>
      )}
    </div>
  );
}

export function PathRow({ label, path, home, target }: { label: string; path: string; home: string; target: 'data' | 'files' }) {
  const toast = useToast();
  const desktop = window.paperReaderDesktop;
  return (
    <SettingsRow
      label={label}
      aside={
        desktop && (
          <button
            className={`${smallBtnCls} shrink-0`}
            onClick={() => desktop.reveal(target).catch(() => toast('폴더를 열지 못했습니다', { tone: 'error' }))}
          >
            {FILE_MANAGER}에서 보기
          </button>
        )
      }
    >
      <p className="truncate font-mono text-[12.5px] text-fg" title={path}>
        {displayPath(path, home)}
      </p>
    </SettingsRow>
  );
}
