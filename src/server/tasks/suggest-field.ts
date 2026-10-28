import { FIELDS, FIELD_LABELS, FIELD_SCOPES, isFieldId, type FieldId } from '../../shared/fields';
import { db, type PaperRow } from '../db';
import { parseJsonLoose } from '../json';
import { runLlm } from '../llm/index';
import { abstractOrPageOne } from '../pdf/context';
import { fill, loadPrompt } from '../prompts';

export async function suggestField(paper: PaperRow): Promise<FieldId | null> {
  const fields = FIELDS.map((f) => `- ${f}: ${FIELD_LABELS[f]} — ${FIELD_SCOPES[f]}`).join('\n');
  const prompt = fill(loadPrompt('field').PROMPT, { title: paper.title, abstract: abstractOrPageOne(paper), fields });
  const { text } = await runLlm({ system: '너는 연구 논문의 학문 분야를 분류한다. JSON 하나로만 답한다.', prompt, profile: 'quick' });
  let parsed: { field?: unknown } | null;
  try {
    parsed = parseJsonLoose<{ field?: unknown } | null>(text);
  } catch {
    return null;
  }
  if (!isFieldId(parsed?.field)) return null;
  db.prepare('UPDATE papers SET field_suggested=? WHERE id=?').run(parsed.field, paper.id);
  return parsed.field;
}
