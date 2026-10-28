import { useEffect, useState } from 'react';
import { FIELDS, FIELD_LABELS, type FieldId } from '../../shared/fields';
import { api } from '../api';
import { usePaper } from '../state/paper';
import { smallBtnCls } from './Dialog';
import { useToast } from './Toast';

const attempted = new Set<string>();

export function FieldConfirmBar() {
  const { paper, reloadPaper } = usePaper();
  const toast = useToast();
  const [choice, setChoice] = useState<FieldId | ''>(paper.fieldSuggested ?? '');
  const [state, setState] = useState<'idle' | 'detecting' | 'failed'>('idle');
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const canDetect = !!paper.abstract?.trim() || paper.status.blockCount > 0;

  useEffect(() => {
    setChoice(paper.fieldSuggested ?? '');
  }, [paper.id, paper.fieldSuggested]);

  useEffect(() => {
    if (paper.fieldSuggested || !canDetect || attempted.has(paper.id)) return;
    attempted.add(paper.id);
    setState('detecting');
    void (async () => {
      try {
        const result = await api<{ suggested: FieldId | null }>(`/api/papers/${paper.id}/field/suggest`, { method: 'POST' });
        await reloadPaper();
        if (result.suggested === null) {
          setError('분야를 판별하지 못했습니다');
          setState('failed');
        } else {
          setState('idle');
        }
      } catch (e) {
        setError((e as Error).message);
        setState('failed');
      }
    })();
  }, [paper.id, paper.fieldSuggested, canDetect, reloadPaper]);

  const confirm = async () => {
    if (!choice) return;
    setSaving(true);
    setSaveError('');
    try {
      await api(`/api/papers/${paper.id}/field`, { method: 'PUT', json: { field: choice } });
      await reloadPaper();
      toast(`분야를 「${FIELD_LABELS[choice]}」로 정했습니다`);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const text = state === 'detecting'
    ? '분야를 자동으로 판별하는 중…'
    : state === 'failed'
      ? `자동 판별 실패: ${error} — 분야를 직접 고르세요.`
      : paper.fieldSuggested
        ? '자동 판별 결과를 확인해 주세요. 분야에 따라 번역 용어, 핵심 용어, Deep Research 작성 틀, 그림 위젯 추천이 달라집니다.'
        : !canDetect
          ? '본문을 불러오면 분야를 자동으로 판별합니다. 직접 골라도 됩니다.'
          : '분야를 직접 고르세요.';

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft/40 px-3 py-2 text-[12.5px] text-fg">
      <span className="min-w-0 flex-1">{text}</span>
      <select aria-label="분야 선택" className="h-8 rounded-lg border border-line bg-surface px-2 text-[12.5px] text-fg" value={choice} onChange={(e) => setChoice(e.target.value as FieldId)}>
        <option value="" disabled>분야 선택</option>
        {FIELDS.map((field) => <option key={field} value={field}>{FIELD_LABELS[field]}</option>)}
      </select>
      <button className={smallBtnCls} disabled={!choice || saving} onClick={() => void confirm()}>확인</button>
      {saveError && <span role="alert" className="text-fg-muted">{saveError}</span>}
    </div>
  );
}
