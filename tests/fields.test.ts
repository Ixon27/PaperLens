import { expect, it } from 'vitest';
import { fieldGuide, fieldPrompt } from '../src/server/fields';
import { FIELD_LABELS, FIELDS, isFieldId, PAREN_CITATION_FIELDS, resolveField } from '../src/shared/fields';

it('provides all field prompt sections and Methods templates', () => {
  for (const field of FIELDS) {
    expect(fieldPrompt(field, 'GUIDE').trim()).not.toBe('');
    expect(fieldPrompt(field, 'METHODS')).toContain('#### Methods');
    expect(fieldPrompt(field, 'FIGURES').trim()).not.toBe('');
    expect(fieldGuide(field)).toBe(`분야: ${FIELD_LABELS[field]}\n${fieldPrompt(field, 'GUIDE')}`);
  }
});

it('validates and resolves fields in priority order', () => {
  for (const field of FIELDS) expect(isFieldId(field)).toBe(true);
  expect(isFieldId('bogus')).toBe(false);
  expect(isFieldId(null)).toBe(false);
  expect(resolveField('physics', 'cs')).toBe('physics');
  expect(resolveField(null, 'cs')).toBe('cs');
  expect(resolveField('bogus', null)).toBe('general');
  expect(resolveField('bogus', 'cs')).toBe('cs');
});

it('enables parenthesized citations for the specified fields', () => {
  expect([...PAREN_CITATION_FIELDS]).toEqual(['life', 'medicine', 'agri', 'general']);
});
