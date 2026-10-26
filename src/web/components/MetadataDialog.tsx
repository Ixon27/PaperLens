import { useState } from 'react';
import { api } from '../api';
import type { Author, PaperDto } from '../types';
import { btnCls, Dialog, Field, inputCls, primaryBtnCls } from './Dialog';
import { useToast } from './Toast';

const authorsToText = (authors: Author[]) => authors.map((a) => (a.given ? `${a.family}, ${a.given}` : a.family)).join('\n');

function textToAuthors(text: string): Author[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [family, ...rest] = l.split(',');
      const given = rest.join(',').trim();
      return given ? { family: family.trim(), given } : { family: family.trim() };
    });
}

export function MetadataDialog({ paper, onClose, onSaved }: { paper: PaperDto; onClose(): void; onSaved(): void }) {
  const [f, setF] = useState({
    title: paper.title,
    authors: authorsToText(paper.authors),
    year: paper.year?.toString() ?? '',
    journal: paper.journal ?? '',
    volume: paper.volume ?? '',
    issue: paper.issue ?? '',
    pages: paper.pages ?? '',
    doi: paper.doi ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const year = f.year.trim() ? parseInt(f.year, 10) : null;
      await api(`/api/papers/${paper.id}`, {
        method: 'PATCH',
        json: {
          title: f.title,
          authors: textToAuthors(f.authors),
          year: Number.isFinite(year) ? year : null,
          journal: f.journal,
          volume: f.volume,
          issue: f.issue,
          pages: f.pages,
          doi: f.doi.trim() || null,
        },
      });
      toast('메타데이터를 저장했습니다');
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="메타데이터"
      onClose={onClose}
      width={600}
      footer={
        <>
          <button className={btnCls} onClick={onClose}>
            취소
          </button>
          <button className={primaryBtnCls} disabled={saving || !f.title.trim()} onClick={() => void save()}>
            저장
          </button>
        </>
      }
    >
      <Field label="제목">
        <textarea className={`${inputCls} h-16 resize-y`} value={f.title} onChange={set('title')} />
      </Field>
      <Field label="저자 (한 줄에 한 명, Family, Given)">
        <textarea className={`${inputCls} h-28 resize-y font-mono text-[12px]`} value={f.authors} onChange={set('authors')} placeholder={'Jo, Young Jae\nShin, Jae-Ho'} />
      </Field>
      <div className="grid grid-cols-[100px_1fr] gap-3">
        <Field label="연도">
          <input className={inputCls} value={f.year} onChange={set('year')} inputMode="numeric" />
        </Field>
        <Field label="저널">
          <input className={inputCls} value={f.journal} onChange={set('journal')} />
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="권 (volume)">
          <input className={inputCls} value={f.volume} onChange={set('volume')} />
        </Field>
        <Field label="호 (issue)">
          <input className={inputCls} value={f.issue} onChange={set('issue')} />
        </Field>
        <Field label="쪽 (pages)">
          <input className={inputCls} value={f.pages} onChange={set('pages')} />
        </Field>
      </div>
      <Field label="DOI" hint="새로 넣으면 OpenAlex에서 ID(OpenAlex·PMID·PMCID)를 같이 채웁니다.">
        <input className={inputCls} value={f.doi} onChange={set('doi')} placeholder="10.xxxx/…" />
      </Field>
      {error && <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</div>}
    </Dialog>
  );
}
