import { describe, expect, it } from 'vitest';
import { validateLineage } from '../src/server/tasks/lineage';

describe('validateLineage', () => {
  const ancestorIds = new Set(['R1', 'R2', 'R3', 'R4']);
  const descendantIds = new Set(['D1']);
  it('filters unknown ids and invalid roles, clips notes, and retains only valid strands', () => {
    const result = validateLineage({
      summary: '계보',
      ancestors: [
        { id: 'R1', role: 'foundation', note: 'x'.repeat(500) },
        { id: 'R2', role: 'method', note: '방법' },
        { id: 'R3', role: 'prior', note: '선행' },
        { id: 'R4', role: 'invalid', note: '' },
        { id: 'R99', role: 'data', note: '' },
      ],
      descendants: [{ id: 'D1', note: 'y'.repeat(500) }, { id: 'D2', note: 'unknown' }],
      strands: [
        { label: 'a'.repeat(40), ids: ['R1', 'R99', 'R2'] },
        { label: 'short', ids: ['R3', 'R4'] },
      ],
    }, ancestorIds, descendantIds);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.ancestors.map((a) => a.id)).toEqual(['R1', 'R2', 'R3']);
    expect(result.ancestors[0].note).toHaveLength(400);
    expect(result.descendants).toEqual([{ id: 'D1', note: 'y'.repeat(400) }]);
    expect(result.strands).toEqual([{ label: 'a'.repeat(30), ids: ['R1', 'R2'] }]);
  });
  it('rejects fewer than three valid ancestors', () => {
    expect(validateLineage({ ancestors: [{ id: 'R1', role: 'prior' }, { id: 'R2', role: 'bad' }, { id: 'R99', role: 'data' }] }, ancestorIds, descendantIds)).toHaveProperty('error');
  });
});
