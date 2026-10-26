import { getSettings } from '../settings';
import { getJson } from './http';

/** Best OA PDF URL from Unpaywall; skipped when no contact email is configured. */
export async function oaPdf(doi: string): Promise<string | null> {
  const email = getSettings().contactEmail;
  if (!email) return null;
  const res = await getJson<{ best_oa_location?: { url_for_pdf?: string | null } | null }>(
    `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`,
  );
  return res?.best_oa_location?.url_for_pdf ?? null;
}
