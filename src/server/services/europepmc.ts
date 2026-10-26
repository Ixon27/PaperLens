import { getJson } from './http';

export interface EpmcItem {
  title: string;
  authorString: string | null;
  journalTitle: string | null;
  pubYear: number | null;
  doi: string | null;
  pmid: string | null;
  citedByCount: number;
}

interface EpmcResult {
  title?: string;
  authorString?: string;
  journalTitle?: string;
  pubYear?: string;
  doi?: string;
  pmid?: string;
  citedByCount?: number;
}

export async function search(query: string): Promise<EpmcItem[]> {
  const res = await getJson<{ resultList?: { result?: EpmcResult[] } }>(
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json&pageSize=10&sort=P_PDATE_D%20desc&resultType=lite`,
  );
  return (res?.resultList?.result ?? []).map((r) => ({
    title: (r.title ?? '').replace(/\.$/, ''),
    authorString: r.authorString ?? null,
    journalTitle: r.journalTitle ?? null,
    pubYear: r.pubYear ? parseInt(r.pubYear, 10) : null,
    doi: r.doi?.toLowerCase() ?? null,
    pmid: r.pmid ?? null,
    citedByCount: r.citedByCount ?? 0,
  }));
}
