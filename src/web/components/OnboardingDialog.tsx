import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../api';
import { THIS_COMPUTER } from '../labels';
import type { Settings, SystemInfo } from '../types';
import { btnCls, Dialog, primaryBtnCls, smallGhostBtnCls } from './Dialog';
import { PathRow, SettingsRow, SettingsSection, VaultPicker } from './SettingsRows';
import { useToast } from './Toast';

interface Setup {
  settings: Settings;
  system: SystemInfo;
  engines: { claude: boolean; codex: boolean };
}

const linkCls = 'text-accent hover:underline';

function InstallPill({ ok }: { ok: boolean }) {
  return ok ? (
    <span className="rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success">설치됨</span>
  ) : (
    <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] font-medium text-fg-muted">설치 필요</span>
  );
}

function Guides({ setup, auth }: { setup: string; auth: string }) {
  return (
    <>
      <a className={linkCls} href={setup} target="_blank" rel="noreferrer">
        설치 방법
      </a>
      {' · '}
      <a className={linkCls} href={auth} target="_blank" rel="noreferrer">
        로그인 방법
      </a>
    </>
  );
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
      const [settings, system, engines] = await Promise.all([
        api<Settings>('/api/settings'),
        api<SystemInfo>('/api/system'),
        api<Setup['engines']>('/api/engines'),
      ]);
      setSetup({ settings, system, engines });
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
          <SettingsSection
            title="AI 연결"
            action={
              <button className={smallGhostBtnCls} disabled={busy} onClick={() => void load()}>
                <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
                다시 확인
              </button>
            }
            note={
              <>
                설치 후 터미널에서 <code className="font-mono text-fg">claude</code> 또는 <code className="font-mono text-fg">codex login</code>을 한 번
                실행해 본인 계정으로 로그인하세요. AI 없이도 PDF 읽기·하이라이트·메모는 쓸 수 있습니다.
              </>
            }
          >
            <SettingsRow
              label="Claude Code"
              aside={<InstallPill ok={setup.engines.claude} />}
              description={<Guides setup="https://code.claude.com/docs/en/setup" auth="https://code.claude.com/docs/en/authentication" />}
            />
            <SettingsRow
              label="Codex"
              aside={<InstallPill ok={setup.engines.codex} />}
              description={<Guides setup="https://developers.openai.com/codex/cli/" auth="https://developers.openai.com/codex/auth/" />}
            />
          </SettingsSection>
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
