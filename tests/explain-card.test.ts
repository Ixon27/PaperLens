import { expect, it } from 'vitest';
import { parseCard } from '../src/web/explain-card';

it('splits the title, the explanation and the follow-up questions', () => {
  const card = parseCard('# 균주의 항생제 감수성\n\n- a [p.3]\n\n#### 생각의 확장\n더 볼 점.\n1. 왜?\n2. 어떻게?\n3. 무엇?');
  expect(card.title).toBe('균주의 항생제 감수성');
  expect(card.body).toContain('- a [p.3]');
  expect(card.body).not.toContain('#');
  expect(card.intro).toBe('더 볼 점.');
  expect(card.questions).toEqual(['왜?', '어떻게?', '무엇?']);
});

it('has no title or questions while the answer lacks them', () => {
  const card = parseCard('- 아직 쓰는 중');
  expect(card.title).toBeNull();
  expect(card.body).toBe('- 아직 쓰는 중');
  expect(card.questions).toEqual([]);
});
