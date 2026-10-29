import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Config from '../src/server/config';
import type { JobRow } from '../src/server/jobs';

vi.mock('../src/server/config', async (importOriginal) => {
  const original = await importOriginal<typeof Config>();
  return { ...original, PATHS: { ...original.PATHS, db: ':memory:' } };
});
vi.mock('../src/server/jobs', () => ({ activeJob: vi.fn(), startJob: vi.fn() }));

import { db } from '../src/server/db';
import { activeJob, startJob } from '../src/server/jobs';
import { retryPaperPdf } from '../src/server/tasks/import';

beforeEach(() => {
  db.prepare('DELETE FROM papers').run();
  db.prepare('INSERT INTO papers(id,title,created_at,updated_at) VALUES(?,?,?,?)').run('paper', 'Example', '2025-01-01', '2025-01-01');
  vi.mocked(activeJob).mockReset().mockReturnValue(null);
  vi.mocked(startJob).mockReset().mockReturnValue('new-job');
});

describe('retrying a cited paper PDF', () => {
  it('starts discovery for a metadata-only paper without creating another paper', () => {
    expect(retryPaperPdf('paper')).toEqual({ paperId: 'paper', duplicate: true, jobId: 'new-job' });
    expect(startJob).toHaveBeenCalledOnce();
    expect(db.prepare('SELECT id FROM papers').all()).toHaveLength(1);
  });

  it('reuses an active import and does not start another', () => {
    vi.mocked(activeJob).mockReturnValue({ id: 'active' } as JobRow);
    expect(retryPaperPdf('paper')).toEqual({ paperId: 'paper', duplicate: true, jobId: 'active' });
    expect(startJob).not.toHaveBeenCalled();
  });

  it('does not start a download when a PDF is already attached', () => {
    db.prepare('UPDATE papers SET pdf_file=? WHERE id=?').run('paper.pdf', 'paper');
    expect(retryPaperPdf('paper')).toEqual({ paperId: 'paper', duplicate: true });
    expect(startJob).not.toHaveBeenCalled();
  });
});
