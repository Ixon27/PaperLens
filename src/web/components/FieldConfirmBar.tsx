import { useEffect, useRef, useState } from 'react';
import { FIELDS, FIELD_LABELS, type FieldId } from '../../shared/fields';
import type { EngineId } from '../../shared/models';
import { api } from '../api';
import { engineLabel } from '../labels';
import { usePaper } from '../state/paper';
import { smallBtnCls } from './Dialog';
import { useToast } from './Toast';

interface FieldSuggestion {
  suggested: FieldId | null;
  engine: EngineId | null;
  skipped: { engine: EngineId; reason: 'usage' | 'auth' | 'missing' }[];
}

const SKIP_REASONS = { usage: '사용량이 없어', auth: '로그인이 필요해', missing: '설치되어 있지 않아' } as const;

export function FieldConfirmBar() {
  const { paper, reloadPaper } = usePaper();
  const toast = useToast();
  const [choice, setChoice] = useState<FieldId | ''>(paper.fieldSuggested ?? '');
  const [state, setState] = useState<'idle' | 'detecting' | 'failed'>('idle');
  const [error, setError] = useState('');
  /** Which engine stood in for the one that could not answer. */
  const [fallbackNote, setFallbackNote] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  // Once per opening of the paper: leaving and reopening it tries again (e.g. after usage refills).
  const attempted = useRef(false);
  const canDetect = !!paper.abstract?.trim() || paper.status.blockCount > 0;

  useEffect(() => {
    setChoice(paper.fieldSuggested ?? '');
  }, [paper.id, paper.fieldSuggested]);

  useEffect(() => {
    if (paper.fieldSuggested || !canDetect || attempted.current) return;
    attempted.current = true;
    setState('detecting');
    void (async () => {
      try {
        const result = await api<FieldSuggestion>(`/api/papers/${paper.id}/field/suggest`, { method: 'POST' });
        const skip = result.skipped[0];
        if (skip && result.engine) setFallbackNote(`${engineLabel(skip.engine)}는 ${SKIP_REASONS[skip.reason]} ${engineLabel(result.engine)}로 판별했습니다.`);
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
      ? `자동 판별 실패: ${error} — 분야를 직접 고르거나, 나중에 이 논문을 다시 열면 자동으로 다시 판별합니다.`
      : paper.fieldSuggested
        ? `자동 판별 결과를 확인해 주세요. ${fallbackNote ? `${fallbackNote} ` : ''}분야에 따라 번역 용어, 핵심 용어, Deep Research 작성 틀, 그림 위젯 추천이 달라집니다.`
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
