import { useEffect, useState } from 'react';
import { api } from '../api';
import { THIS_COMPUTER } from '../labels';
import type { Settings, SystemInfo } from '../types';
import { btnCls, Dialog, primaryBtnCls } from './Dialog';
import { PathRow, SettingsRow, SettingsSection, VaultPicker } from './SettingsRows';
import { ProviderConnections } from './ProviderConnections';
import { useToast } from './Toast';

interface Setup {
  settings: Settings;
  system: SystemInfo;
}


export function OnboardingDialog({ onDone }: { onDone(): void }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [settings, system] = await Promise.all([
        api<Settings>('/api/settings'),
        api<SystemInfo>('/api/system'),
      ]);
      setSetup({ settings, system });
      if (!setup) setVaultPath(settings.vaultPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : '초기 설정을 불러오지 못했습니다');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const finish = async () => {
    if (!setup) return;
    setSaving(true);
    setError(null);
    try {
      await api<Settings>('/api/settings', {
        method: 'PUT',
        json: { vaultPath: vaultPath?.trim() || null, onboardingDone: true },
      });
      toast('준비가 끝났습니다');
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : '초기 설정을 저장하지 못했습니다');
    } finally {
      setSaving(false);
    }
  };

  const busy = loading || saving || choosing;

  return (
    <Dialog
      title="PaperLens 시작하기"
      width={560}
      dismissible={!saving && !choosing}
      onClose={onDone}
      footer={(close) => (
        <>
          <button className={btnCls} disabled={saving || choosing} onClick={close}>
            나중에
          </button>
          <button className={primaryBtnCls} disabled={!setup || busy} onClick={() => void finish()}>
            {saving ? '저장 중…' : '시작하기'}
          </button>
        </>
      )}
    >
      <p className="mb-5 text-[13.5px] leading-relaxed text-fg">
        논문과 메모는 {THIS_COMPUTER}에만 저장됩니다. AI 기능을 쓸 때만 해당 논문 내용이 선택한 AI 서비스로 전송됩니다.
      </p>
      {loading && !setup && <p className="mb-3 text-[13px] text-fg-muted">확인하는 중…</p>}
      {error && (
        <div role="alert" className="mb-3 text-[13px] text-danger">
          <p>{error}</p>
          {!setup && (
            <button className={`${btnCls} mt-2`} disabled={busy} onClick={() => void load()}>
              다시 불러오기
            </button>
          )}
        </div>
      )}
      {setup && (
        <>
          <ProviderConnections desktop={setup.system.desktop} />
          <SettingsSection title="Obsidian (선택)">
            <SettingsRow label="볼트 폴더" description="노트는 볼트의 04_References/Papers 폴더에 저장됩니다.">
              <VaultPicker value={vaultPath} home={setup.system.home} disabled={saving} onBusyChange={setChoosing} onChange={setVaultPath} />
            </SettingsRow>
          </SettingsSection>
          <SettingsSection title="저장 위치">
            <PathRow label="논문 데이터" path={setup.system.dataDir} home={setup.system.home} target="data" />
          </SettingsSection>
        </>
      )}
    </Dialog>
  );
}
