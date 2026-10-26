import { EMAIL } from '../config';
import { getJson } from './http';

/** Best OA PDF URL from Unpaywall; skipped (null) when PAPER_READER_EMAIL is unset. */
export async function oaPdf(doi: string): Promise<string | null> {
  if (!EMAIL) return null;
  const res = await getJson<{ best_oa_location?: { url_for_pdf?: string | null } | null }>(
    `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(EMAIL)}`,
  );
  return res?.best_oa_location?.url_for_pdf ?? null;
}
