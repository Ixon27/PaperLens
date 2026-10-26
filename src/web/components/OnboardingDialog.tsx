import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Settings } from '../types';
import { btnCls, Dialog, Field, inputCls, primaryBtnCls } from './Dialog';
import { useToast } from './Toast';

interface SystemInfo {
  desktop: boolean;
  filesPath: string;
  dbPath: string;
  vaultPath: string | null;
}

interface Setup {
  settings: Settings;
  system: SystemInfo;
  engines: { claude: boolean; codex: boolean };
}

export function OnboardingDialog({ onDone }: { onDone(): void }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [vaultPath, setVaultPath] = useState('');
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
      if (!setup) setVaultPath(settings.vaultPath ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : '초기 설정을 불러오지 못했습니다');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const chooseVault = async () => {
    const desktop = window.paperReaderDesktop;
    if (!desktop) return;
    setChoosing(true);
    setError(null);
    try {
      const selected = await desktop.chooseDirectory();
      if (selected !== null) setVaultPath(selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : '폴더를 선택하지 못했습니다');
    } finally {
      setChoosing(false);
    }
  };

  const finish = async () => {
    if (!setup) return;
    setSaving(true);
    setError(null);
    try {
      await api<Settings>('/api/settings', {
        method: 'PUT',
        json: { vaultPath: vaultPath.trim() || null, onboardingDone: true },
      });
      toast('초기 설정을 저장했습니다');
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
      title="paper-reader 시작하기"
      width={600}
      onClose={() => { if (!saving && !choosing) onDone(); }}
      footer={
        <>
          <button className={btnCls} disabled={saving || choosing} onClick={onDone}>나중에 설정</button>
          <button className={primaryBtnCls} disabled={!setup || busy} onClick={() => void finish()}>
            {saving ? '저장 중…' : '계속'}
          </button>
        </>
      }
    >
      <p className="mb-3 text-[13px] leading-relaxed text-stone-700">
        논문 PDF, 번역·분석 결과와 하이라이트·메모는 이 Mac의 사용자별 저장 공간에 보관합니다.
        AI 기능을 사용하면 논문 본문이나 선택한 이미지가 선택한 AI 서비스로 전송됩니다.
      </p>
      <p className="mb-4 text-[13px] leading-relaxed text-stone-700">
        AI는 각 사용자가 직접 설치하고 로그인한 Claude Code 또는 Codex CLI와 본인의 구독·계정을 사용합니다.
        앱에 계정이나 이용권이 포함되어 있지 않습니다. CLI 없이도 PDF 가져오기·읽기·하이라이트·메모를 사용할 수 있지만,
        번역·분석·채팅 등 AI 기능은 CLI 설치와 로그인이 필요합니다.
      </p>
      {loading && <p className="mb-3 text-[13px] text-stone-500">설정과 CLI 설치 상태를 불러오는 중…</p>}
      {error && (
        <div role="alert" className="mb-3 text-[13px] text-red-700">
          <p>{error}</p>
          {!setup && <button className={`${btnCls} mt-2`} disabled={busy} onClick={() => void load()}>다시 불러오기</button>}
        </div>
      )}
      {setup && (
        <>
          <h3 className="mb-2 text-[13px] font-semibold">이 Mac의 저장 위치</h3>
          <dl className="mb-4 space-y-2 rounded-md bg-stone-50 p-3 text-[12px] text-stone-600">
            <div><dt className="font-semibold">데이터베이스 (읽기 전용)</dt><dd className="break-all select-text">{setup.system.dbPath}</dd></div>
            <div><dt className="font-semibold">PDF·이미지·임시 파일 폴더 (읽기 전용)</dt><dd className="break-all select-text">{setup.system.filesPath}</dd></div>
          </dl>
          <h3 className="mb-2 text-[13px] font-semibold">CLI 실행 파일 검색 결과</h3>
          <ul className="mb-2 space-y-1 text-[13px]">
            <li>Claude Code: {setup.engines.claude ? '실행 파일 발견' : '실행 파일을 찾지 못함'}</li>
            <li>Codex CLI: {setup.engines.codex ? '실행 파일 발견' : '실행 파일을 찾지 못함'}</li>
          </ul>
          <p className="mb-3 text-[12px] text-stone-500">실행 파일 검색 결과일 뿐 로그인·구독 상태를 확인한 것이 아닙니다. 설치와 로그인은 아래 공식 안내에 따라 터미널에서 진행하세요.</p>
          <div className="mb-3 space-y-2 text-[13px]">
            <p>
              <a className="text-blue-700 underline" href="https://code.claude.com/docs/en/setup" target="_blank" rel="noreferrer">Claude Code 공식 설치 안내</a>
              {' · '}
              <a className="text-blue-700 underline" href="https://code.claude.com/docs/en/authentication" target="_blank" rel="noreferrer">인증 안내</a>
              <span className="mt-1 block text-[12px] text-stone-600">설치 후 <code>claude</code>를 실행하고 로그인 안내를 따르세요.</span>
            </p>
            <p>
              <a className="text-blue-700 underline" href="https://developers.openai.com/codex/cli/" target="_blank" rel="noreferrer">Codex CLI 공식 설치 안내</a>
              {' · '}
              <a className="text-blue-700 underline" href="https://developers.openai.com/codex/auth/" target="_blank" rel="noreferrer">인증 안내</a>
              <span className="mt-1 block text-[12px] text-stone-600">설치 후 <code>codex login</code>으로 본인 계정에 로그인하세요.</span>
            </p>
          </div>
          <button className={`${btnCls} mb-4`} disabled={busy} onClick={() => void load()}>설치 상태 다시 확인</button>
          <Field label="Obsidian 볼트 폴더 (선택)" hint="내보내기를 원할 때만 볼트의 전체 경로를 입력하세요. 비워 두어도 PDF를 읽을 수 있습니다. 기존 파일이나 노트를 이동하지 않습니다.">
            <input className={inputCls} placeholder="/볼트/전체/경로" value={vaultPath} disabled={busy} onChange={(e) => setVaultPath(e.target.value)} />
          </Field>
          {window.paperReaderDesktop && (
            <button className={`${btnCls} mb-3`} disabled={busy} onClick={() => void chooseVault()}>
              {choosing ? '폴더 선택 중…' : '볼트 폴더 선택…'}
            </button>
          )}
          <p className="text-[12px] text-stone-500">모델·읽는 사람 설명·연락 이메일과 볼트 경로는 나중에 설정에서 바꿀 수 있습니다. 저장 공간 위치는 이 화면에서 변경하지 않습니다.</p>
        </>
      )}
    </Dialog>
  );
}
