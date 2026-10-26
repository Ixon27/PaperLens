import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Settings } from '../types';
import { btnCls, Dialog, Field, inputCls, primaryBtnCls } from './Dialog';
import { useToast } from './Toast';

const EFFORTS = ['minimal', 'low', 'medium', 'high'];

export function SettingsDialog({ onClose }: { onClose(): void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [system, setSystem] = useState<{ dbPath: string; filesPath: string; vaultPath: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const toast = useToast();

  const load = async () => {
    setError(null);
    try {
      const [settings, info] = await Promise.all([
        api<Settings>('/api/settings'),
        api<{ dbPath: string; filesPath: string; vaultPath: string | null }>('/api/system'),
      ]);
      setS(settings);
      setSystem(info);
    } catch (e) {
      setError(e instanceof Error ? e.message : '설정을 불러오지 못했습니다');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const chooseVault = async () => {
    const desktop = window.paperReaderDesktop;
    if (!desktop) return;
    setChoosing(true);
    try {
      const path = await desktop.chooseDirectory();
      if (path !== null) setS((current) => current ? { ...current, vaultPath: path } : current);
    } catch (e) {
      toast(e instanceof Error ? e.message : '폴더를 선택하지 못했습니다', { tone: 'error' });
    } finally {
      setChoosing(false);
    }
  };

  const save = async () => {
    if (!s) return;
    setSaving(true);
    try {
      const saved = await api<Settings>('/api/settings', {
        method: 'PUT',
        json: { ...s, vaultPath: s.vaultPath?.trim() || null, contactEmail: s.contactEmail.trim() },
      });
      window.dispatchEvent(new CustomEvent('pr:engine', { detail: saved.engine }));
      toast('설정을 저장했습니다');
      onClose();
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="설정"
      onClose={onClose}
      footer={
        <>
          <button className={btnCls} onClick={onClose}>
            취소
          </button>
          <button className={primaryBtnCls} disabled={!s || saving || choosing} onClick={() => void save()}>
            저장
          </button>
        </>
      }
    >
      {error && (
        <div role="alert" className="mb-3 text-[13px] text-red-700">
          <p>{error}</p>
          <button className={`${btnCls} mt-2`} onClick={() => void load()}>다시 불러오기</button>
        </div>
      )}
      {!s ? (
        !error && <div className="text-[13px] text-stone-500">불러오는 중…</div>
      ) : (
        <>
          <Field label="AI 엔진">
            <div className="flex gap-4 text-[13px]">
              {(['claude', 'codex'] as const).map((e) => (
                <label key={e} className="flex items-center gap-1.5">
                  <input type="radio" name="engine" checked={s.engine === e} onChange={() => setS({ ...s, engine: e })} />
                  {e === 'claude' ? 'Claude' : 'Codex'}
                </label>
              ))}
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Claude 빠른 모델 (quick)">
              <input className={inputCls} placeholder="sonnet" value={s.claude.quickModel} onChange={(e) => setS({ ...s, claude: { ...s.claude, quickModel: e.target.value } })} />
            </Field>
            <Field label="Claude 깊은 모델 (heavy)">
              <input className={inputCls} placeholder="opus" value={s.claude.heavyModel} onChange={(e) => setS({ ...s, claude: { ...s.claude, heavyModel: e.target.value } })} />
            </Field>
          </div>
          <Field label="Codex 모델" hint="비워 두면 Codex CLI의 기본 모델을 사용합니다.">
            <input className={inputCls} placeholder="CLI 기본 모델" value={s.codex.model} onChange={(e) => setS({ ...s, codex: { ...s.codex, model: e.target.value } })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Codex 빠른 작업 effort">
              <select className={inputCls} value={s.codex.quickEffort} onChange={(e) => setS({ ...s, codex: { ...s.codex, quickEffort: e.target.value } })}>
                {EFFORTS.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </Field>
            <Field label="Codex 깊은 작업 effort">
              <select className={inputCls} value={s.codex.heavyEffort} onChange={(e) => setS({ ...s, codex: { ...s.codex, heavyEffort: e.target.value } })}>
                {EFFORTS.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="읽는 사람 (분석·채팅 프롬프트의 {context})">
            <textarea className={`${inputCls} h-28 resize-y`} value={s.readerContext} onChange={(e) => setS({ ...s, readerContext: e.target.value })} />
          </Field>
          <p className="text-[11.5px] text-stone-500">quick: 선택 번역·채팅·그림 설명·전체 번역·참고문헌·분류·파일명. heavy: 구조 분석·마인드맵.</p>
          <h3 className="mb-3 mt-5 text-[13px] font-semibold">저장 공간 · 외부 서비스</h3>
          {system && (
            <div className="mb-3 rounded-md bg-stone-50 p-3 text-[12px] text-stone-600">
              <dl className="space-y-2">
                <div><dt className="font-semibold">데이터베이스 (읽기 전용)</dt><dd className="break-all select-text">{system.dbPath}</dd></div>
                <div><dt className="font-semibold">PDF·이미지·임시 파일 폴더 (읽기 전용)</dt><dd className="break-all select-text">{system.filesPath}</dd></div>
                <div><dt className="font-semibold">현재 적용된 Obsidian 볼트</dt><dd className="break-all select-text">{system.vaultPath ?? '지정하지 않음'}</dd></div>
              </dl>
              <p className="mt-2">이 화면에서는 데이터 저장 위치를 변경하거나 기존 파일을 이동하지 않습니다.</p>
            </div>
          )}
          <Field label="Obsidian 볼트 폴더 (선택)" hint="내보내기에 사용할 볼트의 전체 경로입니다. 비워 두면 볼트를 지정하지 않습니다. 기존 노트나 PDF를 이동하지 않습니다.">
            <input className={inputCls} placeholder="/볼트/전체/경로" value={s.vaultPath ?? ''} onChange={(e) => setS({ ...s, vaultPath: e.target.value || null })} />
          </Field>
          {window.paperReaderDesktop && (
            <button className={`${btnCls} mb-3`} disabled={choosing || saving} onClick={() => void chooseVault()}>
              {choosing ? '폴더 선택 중…' : '볼트 폴더 선택…'}
            </button>
          )}
          <Field label="연락 이메일 (선택)" hint="OpenAlex·Crossref 요청의 연락처로 사용하며, 입력하면 Unpaywall에서 공개 PDF를 찾을 수 있습니다. 해당 외부 서비스로 전송됩니다.">
            <input type="email" className={inputCls} placeholder="name@example.com" value={s.contactEmail} onChange={(e) => setS({ ...s, contactEmail: e.target.value })} />
          </Field>
        </>
      )}
    </Dialog>
  );
}
