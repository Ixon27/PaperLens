import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { btnCls, smallGhostBtnCls } from './Dialog';
import { SettingsRow, SettingsSection } from './SettingsRows';

type Engine = 'claude' | 'codex';
type Status = { installed: boolean; auth: 'connected' | 'disconnected' | 'unknown'; canInstall: boolean; operation: { kind: 'connect'; phase: 'install' | 'login'; state: 'running' | 'success' | 'error' | 'cancelled'; message: string; codeNeeded: boolean } | null };
const providers = [
  { id: 'claude', name: 'Claude Code', setup: 'https://code.claude.com/docs/en/setup', auth: 'https://code.claude.com/docs/en/authentication' },
  { id: 'codex', name: 'Codex', setup: 'https://developers.openai.com/codex/cli/', auth: 'https://developers.openai.com/codex/auth/' },
] as const;

function ProviderRow({ id, name, setup, auth, desktop }: { id: Engine; name: string; setup: string; auth: string; desktop: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);
  const previous = useRef<Status | null>(null);
  const refresh = useCallback(async () => {
    try { setStatus(await api<Status>(`/api/providers/${id}`)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : '상태를 확인하지 못했습니다'); }
  }, [id]);
  useEffect(() => { if (desktop) void refresh(); }, [desktop, refresh]);
  useEffect(() => {
    const before = previous.current;
    if (status?.operation?.state === 'running' && before?.operation?.state !== 'running') {
      window.dispatchEvent(new CustomEvent('paperlens-provider-started', { detail: id }));
    }
    if (status && (
      (status.installed && (before?.installed === false || (!before && status.operation !== null)))
      || (status.auth === 'connected' && before?.auth !== 'connected')
      || (status.operation?.state === 'success' && status.auth === 'connected' && before?.operation?.state === 'running')
    )) {
      window.dispatchEvent(new Event('paperlens-provider-changed'));
    }
    previous.current = status;
  }, [id, status]);
  useEffect(() => {
    if (status?.operation?.state !== 'running') return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [status?.operation?.state, refresh]);
  const action = async (name: 'connect' | 'cancel') => {
    setBusy(true); setError(null);
    try {
      await api(`/api/providers/${id}/${name}`, { method: 'POST' });
      if (name === 'connect') window.dispatchEvent(new CustomEvent('paperlens-provider-started', { detail: id }));
      await refresh();
    }
    catch (e) { setError(e instanceof Error ? e.message : '작업을 시작하지 못했습니다'); }
    finally { setBusy(false); }
  };
  const sendCode = async () => {
    const input = codeInput.current;
    if (!input || !input.value.trim()) return;
    const code = input.value;
    input.value = '';
    setBusy(true); setError(null);
    try { await api(`/api/providers/${id}/code`, { method: 'POST', json: { code } }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : '코드를 전달하지 못했습니다'); }
    finally { setBusy(false); }
  };
  const running = status?.operation?.state === 'running';
  const label = !status ? (error ? '상태 확인 실패' : '확인 중') : running ? (status.operation?.phase === 'install' ? '설치 중' : '로그인 중') : !status.installed ? '설치 필요' : status.auth === 'connected' ? '연결됨' : status.auth === 'disconnected' ? '로그인 필요' : '연결 상태 확인 불가';
  return (
    <SettingsRow label={name} aside={desktop ? <span className="text-[11px] text-fg-muted">{label}</span> : undefined}
      description={<><a className="text-accent hover:underline" href={setup} target="_blank" rel="noreferrer">공식 설치 안내</a>{' · '}<a className="text-accent hover:underline" href={auth} target="_blank" rel="noreferrer">로그인 도움말</a></>}>
      {desktop && <div className="mt-2 space-y-2">
        <div className="flex flex-wrap gap-2">
          {running ? <button className={btnCls} disabled={busy} onClick={() => void action('cancel')}>취소</button> : <>
            {status && <button className={btnCls} disabled={busy || (!status.installed && !status.canInstall)} onClick={() => void action('connect')}>{status.operation?.state === 'error' || status.operation?.state === 'cancelled' ? '브라우저 계정 연결 다시 시도' : status.auth === 'connected' ? '계정 다시 연결' : '브라우저 계정 연결'}</button>}
            <button className={smallGhostBtnCls} disabled={busy} onClick={() => void refresh()}>다시 확인</button>
          </>}
        </div>
        {status && !status.installed && !status.canInstall && <p className="text-[12px] text-fg-muted">이 운영체제 또는 CPU는 자동 설치를 지원하지 않습니다. 공식 설치 안내를 이용하세요.</p>}
        {status?.operation?.message && !(status.operation.state === 'success' && status.auth !== 'connected') && <p role={status.operation.state === 'error' ? 'alert' : 'status'} className={status.operation.state === 'error' ? 'text-[12px] text-danger' : 'text-[12px] text-fg-muted'}>{status.operation.message}</p>}
        {status?.operation?.state === 'success' && status.auth !== 'connected' && <p role="status" className="text-[12px] text-fg-muted">로그인 완료 여부를 확인할 수 없습니다. 다시 확인하거나 연결을 다시 시도하세요.</p>}
        {id === 'claude' && running && status?.operation?.codeNeeded && <div className="space-y-2">
          <p className="text-[12px] text-fg-muted">브라우저가 로그인 코드를 보여준 경우에만 여기에 붙여 넣으세요. 브라우저가 자동으로 완료하면 비워 두세요.</p>
          <div className="flex gap-2"><input ref={codeInput} type="password" autoComplete="off" aria-label="브라우저 로그인 코드" className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-fg" /><button className={btnCls} disabled={busy} onClick={() => void sendCode()}>코드 전달</button></div>
        </div>}
        {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      </div>}
    </SettingsRow>
  );
}

export function ProviderConnections({ desktop }: { desktop: boolean }) {
  return <SettingsSection title="AI 연결" note={desktop ? '비밀번호나 토큰은 앱에 입력하지 않습니다. 브라우저가 별도 코드를 표시할 때만 CLI에 전달합니다.' : '계정 연결은 데스크톱 앱에서 할 수 있습니다. AI 없이도 PDF를 읽을 수 있습니다.'}>
    {desktop && <p className="px-4 py-3 text-[12px] leading-relaxed text-fg-muted">사용할 서비스 하나를 연결하세요. 처음에는 공식 CLI를 자동 설치한 뒤 브라우저에서 로그인합니다. 연결되면 해당 서비스를 기본 AI로 선택합니다.</p>}
    {providers.map((p) => <ProviderRow key={p.id} {...p} desktop={desktop} />)}
  </SettingsSection>;
}
