import { describe, expect, it } from 'vitest';
import { arxivYear, parseImportInput } from '../src/server/tasks/import';

describe('import input', () => {
  it('recognizes arXiv DOIs before ordinary DOIs', () => {
    expect(parseImportInput('https://doi.org/10.48550/arXiv.1706.03762')).toEqual({ kind: 'arxiv', id: '1706.03762' });
    expect(parseImportInput('10.1103/PhysRevLett.116.061102')).toEqual({ kind: 'doi', doi: '10.1103/physrevlett.116.061102' });
  });

  it('recognizes old and new arXiv IDs without their versions', () => {
    expect(parseImportInput('arXiv:hep-th/9711200v2')).toEqual({ kind: 'arxiv', id: 'hep-th/9711200' });
    expect(parseImportInput('https://arxiv.org/pdf/2401.00001v2.pdf')).toEqual({ kind: 'arxiv', id: '2401.00001' });
  });

  it('derives the publication year from old and new IDs', () => {
    expect(arxivYear('hep-th/9711200')).toBe(1997);
    expect(arxivYear('2401.00001')).toBe(2024);
  });
});
