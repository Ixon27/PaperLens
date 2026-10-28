import { FIELD_LABELS, type FieldId } from '../shared/fields';
import { loadPrompt } from './prompts';

export function fieldPrompt(field: FieldId, part: 'GUIDE' | 'METHODS' | 'FIGURES'): string {
  const section = loadPrompt('fields')[`${field}:${part}`];
  if (!section) throw new Error(`prompts/fields.md 에 ${field}:${part} 섹션이 없습니다`);
  return section;
}

export const fieldGuide = (field: FieldId) => `분야: ${FIELD_LABELS[field]}\n${fieldPrompt(field, 'GUIDE')}`;
