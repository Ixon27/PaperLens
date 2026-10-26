import { Hono } from 'hono';
import { HttpError } from '../http-error';
import { libraryIdForDoi, getRelated } from '../tasks/related';
import { loadReferences, startReferences, type RefEntry } from '../tasks/references';
import { requirePaper } from './papers';

export const citations = new Hono();

const withLibrary = (entries: RefEntry[]) => entries.map((e) => ({ ...e, inLibrary: libraryIdForDoi(e.doi) }));

citations.post('/papers/:id/references', (c) => {
  const p = requirePaper(c.req.param('id'));
  return c.json({ jobId: startReferences(p.id) });
});

/** Full references list (or `entries: null` while none is extracted yet). */
citations.get('/papers/:id/references', (c) => {
  const p = requirePaper(c.req.param('id'));
  const entries = loadReferences(p.id);
  return c.json({ entries: entries ? withLibrary(entries) : null });
});

citations.get('/papers/:id/citation', (c) => {
  const p = requirePaper(c.req.param('id'));
  const keysParam = c.req.query('keys');
  const family = c.req.query('family')?.trim();
  const year = c.req.query('year')?.trim();
  if (!keysParam && !(family && year)) throw new HttpError(400, 'keys 또는 family·year 가 필요합니다');

  const entries = loadReferences(p.id);
  if (!entries) return c.json({ status: 'pending', jobId: startReferences(p.id) });

  let found: RefEntry[];
  if (keysParam) {
    const keys = keysParam
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    found = keys.map((k) => entries.find((e) => e.key === k)).filter((e): e is RefEntry => e !== undefined);
  } else {
    const fam = family!.toLowerCase();
    const sameYear = (e: RefEntry) => e.year !== null && String(e.year) === year;
    found = entries.filter((e) => e.key.toLowerCase().startsWith(fam) && sameYear(e));
    if (!found.length) found = entries.filter((e) => (e.authors ?? '').toLowerCase().includes(fam) && sameYear(e));
  }
  return c.json({ status: 'ok', entries: withLibrary(found) });
});

citations.get('/papers/:id/related', async (c) => {
  const p = requirePaper(c.req.param('id'));
  return c.json(await getRelated(p, c.req.query('refresh') === '1'));
});
