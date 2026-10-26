import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Settings } from '../types';
import { btnCls, Dialog, Field, inputCls, primaryBtnCls } from './Dialog';
import { useToast } from './Toast';

const EFFORTS = ['minimal', 'low', 'medium', 'high'];

export function SettingsDialog({ onClose }: { onClose(): void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    void api<Settings>('/api/settings').then(setS);
  }, []);

  const save = async () => {
    if (!s) return;
    setSaving(true);
    try {
      const saved = await api<Settings>('/api/settings', { method: 'PUT', json: s });
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
          <button className={primaryBtnCls} disabled={!s || saving} onClick={() => void save()}>
            저장
          </button>
        </>
      }
    >
      {!s ? (
        <div className="text-[13px] text-stone-500">불러오는 중…</div>
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
          <Field label="Codex 모델">
            <input className={inputCls} value={s.codex.model} onChange={(e) => setS({ ...s, codex: { ...s.codex, model: e.target.value } })} />
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
        </>
      )}
    </Dialog>
  );
}
