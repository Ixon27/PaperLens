import { useEffect, useState } from 'react';
import { api } from '../api';
import { usePaper } from '../state/paper';
import { btnCls, Dialog, Field, inputCls, primaryBtnCls } from './Dialog';
import { useToast } from './Toast';

interface Preview {
  filename: string;
  tags: string[];
  relatedSuggestions: string[];
  exists: boolean;
  hasAnalysis: boolean;
}

export function ExportDialog({ onClose }: { onClose(): void }) {
  const { paper } = usePaper();
  const toast = useToast();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [filename, setFilename] = useState('');
  const [tags, setTags] = useState('');
  const [checked, setChecked] = useState<string[]>([]);
  const [extra, setExtra] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paperId = paper?.id;

  useEffect(() => {
    if (!paperId) return;
    const ac = new AbortController();
    api<Preview>(`/api/papers/${paperId}/export/preview`, { method: 'POST', signal: ac.signal })
      .then((p) => {
        setPreview(p);
        setFilename(p.filename);
        setTags(p.tags.join(', '));
        setChecked(p.relatedSuggestions);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      });
    return () => ac.abort();
  }, [paperId]);

  async function submit() {
    if (!paperId) return;
    setSaving(true);
    setError(null);
    try {
      const relatedNotes = [...checked, ...extra.split(',').map((s) => s.trim().replace(/^\[\[|\]\]$/g, ''))].filter(Boolean);
      const res = await api<{ path: string }>(`/api/papers/${paperId}/export`, {
        method: 'POST',
        json: {
          filename: filename.trim(),
          tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
          relatedNotes: [...new Set(relatedNotes)],
          overwrite,
        },
      });
      toast(`내보냄: ${res.path}`, { link: { label: 'Obsidian에서 열기', href: `obsidian://open?path=${encodeURIComponent(res.path)}` } });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const footer = (
    <>
      <button className={btnCls} onClick={onClose}>
        취소
      </button>
      <button className={primaryBtnCls} disabled={!preview || saving || !filename.trim()} onClick={() => void submit()}>
        {saving ? '내보내는 중…' : '내보내기'}
      </button>
    </>
  );

  return (
    <Dialog title="Obsidian으로 내보내기" onClose={onClose} footer={footer} width={560}>
      {!preview ? (
        error ? (
          <p className="text-[13px] text-red-600">{error}</p>
        ) : (
          <p className="flex items-center gap-2 text-[13px] text-stone-500">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-stone-700" />
            파일 이름·태그 준비 중…
          </p>
        )
      ) : (
        <>
          {!preview.hasAnalysis && (
            <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">분석 없이 하이라이트만 내보냅니다</p>
          )}
          <Field label="파일 이름" hint="04_References/Papers/ 아래에 저장됩니다">
            <input className={inputCls} value={filename} onChange={(e) => setFilename(e.target.value)} />
          </Field>
          <Field label="태그 (쉼표로 구분)">
            <input className={inputCls} value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
          <div className="mb-3">
            <span className="mb-1 block text-[12px] font-semibold text-stone-600">관련 노트</span>
            {preview.relatedSuggestions.length === 0 && <p className="mb-1 text-[12px] text-stone-400">추천 없음</p>}
            {preview.relatedSuggestions.map((n) => (
              <label key={n} className="flex items-center gap-2 py-0.5 text-[13px]">
                <input
                  type="checkbox"
                  checked={checked.includes(n)}
                  onChange={(e) => setChecked((c) => (e.target.checked ? [...c, n] : c.filter((x) => x !== n)))}
                />
                [[{n}]]
              </label>
            ))}
            <input className={`${inputCls} mt-1`} placeholder="직접 추가 (쉼표로 구분)" value={extra} onChange={(e) => setExtra(e.target.value)} />
          </div>
          {preview.exists && (
            <label className="mb-2 flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
              덮어쓰기
            </label>
          )}
          {error && <p className="text-[13px] text-red-600">{error}</p>}
        </>
      )}
    </Dialog>
  );
}
