import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { smallBtnCls, smallPrimaryBtnCls } from '../components/Dialog';
import { JobBar } from '../components/JobBar';
import { ModelBadge } from '../components/ModelBadge';
import { LibraryButton, RefCard, useImportPaper, type RefEntryDto, type WorkSummaryDto } from '../pdf/CitationPopover';
import { usePaper } from '../state/paper';
import { useJob } from '../state/useJob';
import type { MadeBy } from '../../shared/models';

interface EpmcItemDto {
  title: string;
  authorString: string | null;
  journalTitle: string | null;
  pubYear: number | null;
  doi: string | null;
  pmid: string | null;
  citedByCount: number;
  inLibrary: string | null;
}

type Source = 'related' | 'recentCiting' | 'topCiting' | 'epmc';

interface RelatedDto {
  fetchedAt: string;
  related: WorkSummaryDto[];
  recentCiting: WorkSummaryDto[];
  topCiting: WorkSummaryDto[];
  epmc: { keywords: string[]; items: EpmcItemDto[] } | null;
  errors: Source[];
}

/** One row shape for both OpenAlex and Europe PMC items. */
interface RelatedRow {
  key: string;
  title: string;
  doi: string | null;
  authors: string | null;
  year: number | null;
  venue: string | null;
  citedBy: number;
  oa: boolean;
  inLibrary: string | null;
}

function fromOpenAlex(w: WorkSummaryDto): RelatedRow {
  return {
    key: w.openalexId,
    title: w.title,
    doi: w.doi,
    authors: w.authors.length ? w.authors[0] + (w.authors.length > 1 ? ' et al.' : '') : null,
    year: w.year,
    venue: w.venue,
    citedBy: w.citedBy,
    oa: Boolean(w.oaPdf),
    inLibrary: w.inLibrary,
  };
}

function fromEpmc(it: EpmcItemDto, i: number): RelatedRow {
  return {
    key: it.pmid ?? it.doi ?? `epmc-${i}`,
    title: it.title,
    doi: it.doi,
    authors: it.authorString,
    year: it.pubYear,
    venue: it.journalTitle,
    citedBy: it.citedByCount,
    oa: false,
    inLibrary: it.inLibrary,
  };
}

function RelatedItem({ row }: { row: RelatedRow }) {
  const imp = useImportPaper(row.inLibrary);
  return (
    <li className="border-b border-line py-2 last:border-0">
      <div className="text-[12.5px] font-medium leading-snug text-fg">
        {row.doi ? (
          <a className="hover:underline" href={`https://doi.org/${row.doi}`} target="_blank" rel="noreferrer">
            {row.title}
          </a>
        ) : (
          row.title
        )}
        {row.oa && <span className="ml-1.5 rounded bg-success-soft px-1 py-px align-middle text-[10px] font-semibold text-success">무료 PDF</span>}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-fg-muted">
        {[row.authors, row.year, row.venue, `인용 ${row.citedBy}`].filter((x) => x !== null && x !== '').join(' · ')}
        <span className="ml-auto">
          <LibraryButton imp={imp} doi={row.doi} label="가져오기" />
        </span>
      </div>
    </li>
  );
}

function Group({ title, rows, failed }: { title: string; rows: RelatedRow[]; failed: boolean }) {
  return (
    <section className="mb-4">
      <h4 className="mb-1 text-[12px] font-semibold text-fg-muted">{title}</h4>
      {failed ? (
        <div className="text-[12px] text-danger">불러오지 못했습니다</div>
      ) : rows.length ? (
        <ul>
          {rows.map((r) => (
            <RelatedItem key={r.key} row={r} />
          ))}
        </ul>
      ) : (
        <div className="text-[12px] text-fg-dim">없음</div>
      )}
    </section>
  );
}

function RelatedSection({ paperId }: { paperId: string }) {
  const [data, setData] = useState<RelatedDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (refresh: boolean) => {
      setLoading(true);
      setError(null);
      try {
        setData(await api<RelatedDto>(`/api/papers/${paperId}/related${refresh ? '?refresh=1' : ''}`));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [paperId],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const failed = (s: Source) => data?.errors.includes(s) ?? false;

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold text-fg">관련 논문</h3>
        {loading && <span className="text-[12px] text-fg-muted">불러오는 중…</span>}
        <button
          className={`ml-auto ${smallBtnCls}`}
          disabled={loading}
          onClick={() => void load(true)}
        >
          새로고침
        </button>
      </div>
      {error && <div className="mb-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{error}</div>}
      {data && (
        <>
          <Group title="비슷한 논문" rows={data.related.map(fromOpenAlex)} failed={failed('related')} />
          <Group title="최근 이 논문을 인용한 논문" rows={data.recentCiting.map(fromOpenAlex)} failed={failed('recentCiting')} />
          <Group title="많이 인용된 인용 논문" rows={data.topCiting.map(fromOpenAlex)} failed={failed('topCiting')} />
          {data.epmc ? (
            <Group
              title={`같은 주제의 최신 논문 · ${data.epmc.keywords.join(', ')}`}
              rows={data.epmc.items.map(fromEpmc)}
              failed={failed('epmc')}
            />
          ) : (
            <section className="mb-4">
              <h4 className="mb-1 text-[12px] font-semibold text-fg-muted">같은 주제의 최신 논문</h4>
              <div className="text-[12px] text-fg-dim">{failed('epmc') ? '불러오지 못했습니다' : '주제 키워드를 찾지 못해 검색하지 않았습니다'}</div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function ReferencesSection({ paperId }: { paperId: string }) {
  const [entries, setEntries] = useState<RefEntryDto[] | null | undefined>(undefined);
  const [by, setBy] = useState<MadeBy | null>(null);
  const load = useCallback(async () => {
    const r = await api<{ entries: RefEntryDto[] | null; by: MadeBy | null }>(`/api/papers/${paperId}/references`);
    setEntries(r.entries);
    setBy(r.by);
  }, [paperId]);
  const job = useJob('references', { onFinish: () => void load() });

  useEffect(() => {
    void load();
  }, [load]);

  const start = async () => {
    const r = await api<{ jobId: string }>(`/api/papers/${paperId}/references`, { method: 'POST' });
    job.attach(r.jobId);
  };

  return (
    <div className="mb-6">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold text-fg">참고문헌{entries ? ` (${entries.length})` : ''}</h3>
        <span className="ml-auto min-w-0">
          <ModelBadge by={by} />
        </span>
      </div>
      {entries === null && !job.running && (
        <button className={`mb-2 ${smallPrimaryBtnCls}`} onClick={() => void start()}>
          참고문헌 추출
        </button>
      )}
      {entries === null && <JobBar job={job.job} onCancel={() => void job.cancel()} />}
      {entries && entries.length === 0 && <div className="text-[12px] text-fg-dim">추출된 참고문헌이 없습니다</div>}
      {entries && entries.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {entries.map((e) => (
            <RefCard key={e.key} entry={e} />
          ))}
        </div>
      )}
    </div>
  );
}

export function CitationsPanel() {
  const { paper } = usePaper();
  return (
    <div className="p-3">
      <ReferencesSection paperId={paper.id} />
      <RelatedSection paperId={paper.id} />
    </div>
  );
}
