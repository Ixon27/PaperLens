import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { SyncStatusDto } from '../types';
import { btnCls, primaryBtnCls, smallGhostBtnCls } from './Dialog';
import { SettingsRow, SettingsSection } from './SettingsRows';

const when = (iso: string) => new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Google Drive sync: sign in through the browser, then the backend syncs every few minutes. */
export function SyncSettings() {
  const [status, setStatus] = useState<SyncStatusDto | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api<SyncStatusDto>('/api/sync/status'));
    } catch (e) {
      setError(e instanceof Error ? e.message : '동기화 상태를 확인하지 못했습니다');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const waiting = !!status && (status.syncing || status.loginPending);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void refresh(), 1500);
    return () => clearInterval(t);
  }, [waiting, refresh]);

  useEffect(() => {
    if (status && !status.loginPending) setLoginUrl(null);
  }, [status]);

  const act = async (path: 'connect' | 'disconnect' | 'now') => {
    setBusy(true);
    setError(null);
    try {
      if (path === 'connect') setLoginUrl((await api<{ url: string }>('/api/sync/connect', { method: 'POST' })).url);
      else await api(`/api/sync/${path}`, { method: 'POST' });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '요청을 처리하지 못했습니다');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = () => {
    if (confirm('이 기기에서 Google Drive 연결을 해제할까요?\n\n이 기기의 논문과 Google Drive에 올라간 자료는 그대로 남습니다.')) void act('disconnect');
  };

  return (
    <SettingsSection
      title="기기 간 동기화"
      note="논문 PDF·번역·분석·하이라이트·대화·용어가 본인 Google Drive의 PaperLens 전용 숨김 폴더에 저장됩니다. Google 로그인 정보는 이 기기에 암호화해 보관합니다. AI 서비스 로그인은 기기마다 따로 연결합니다."
    >
      {!status ? (
        <SettingsRow label="Google Drive" description={error ?? '확인 중…'} />
      ) : !status.available ? (
        <SettingsRow label="Google Drive" description="데스크톱 앱에서 사용할 수 있습니다." />
      ) : !status.configured ? (
        <SettingsRow label="Google Drive" aside={<span className="text-[11px] text-fg-muted">준비 중</span>} description="이 버전에는 Google 연동 정보가 아직 들어 있지 않아 연결할 수 없습니다." />
      ) : !status.connected ? (
        <SettingsRow
          label="Google Drive"
          aside={<span className="text-[11px] text-fg-muted">{status.loginPending ? '로그인 중' : '연결 안 됨'}</span>}
          description="같은 Google 계정을 연결한 Mac·Windows 기기끼리 논문과 분석 결과를 이어서 볼 수 있습니다."
        >
          {status.loginPending ? (
            <div className="space-y-2">
              <p role="status" className="text-[12px] text-fg-muted">브라우저에서 Google 계정을 고르고 허용하세요. 완료되면 자동으로 첫 동기화를 시작합니다.</p>
              {loginUrl && (
                <a className="text-[12px] text-accent hover:underline" href={loginUrl} target="_blank" rel="noreferrer">
                  브라우저가 열리지 않았다면 여기를 누르세요
                </a>
              )}
            </div>
          ) : (
            <button className={primaryBtnCls} disabled={busy} onClick={() => void act('connect')}>
              Google 계정 연결
            </button>
          )}
        </SettingsRow>
      ) : (
        <SettingsRow
          label="Google Drive"
          aside={<span className="text-[11px] text-fg-muted">{status.syncing ? '동기화 중…' : '연결됨'}</span>}
          description={[
            status.email,
            status.lastSyncAt ? `마지막 동기화 ${when(status.lastSyncAt)}` : '아직 동기화하지 않음',
            status.devices > 1 ? `기기 ${status.devices}대` : null,
          ].filter(Boolean).join(' · ')}
        >
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <button className={btnCls} disabled={busy || status.syncing} onClick={() => void act('now')}>
                {status.syncing ? '동기화 중…' : '지금 동기화'}
              </button>
              <button className={smallGhostBtnCls} disabled={busy} onClick={disconnect}>
                연결 해제
              </button>
            </div>
            <p className="text-[12px] text-fg-muted">앱이 켜져 있는 동안 5분마다 자동으로 동기화합니다.</p>
            {status.conflicts > 0 && (
              <p className="text-[12px] text-fg-muted">
                두 기기에서 같은 내용을 동시에 고친 {status.conflicts}건은 최신 내용을 쓰고, 덮인 이전 내용은 이 기기의 데이터베이스에 보관했습니다.
              </p>
            )}
          </div>
        </SettingsRow>
      )}
      {(error || status?.lastError) && (
        <p role="alert" className="px-4 py-3 text-[12px] text-danger">
          {error ?? status?.lastError}
        </p>
      )}
    </SettingsSection>
  );
}
