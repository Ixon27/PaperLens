import { FIELDS, FIELD_LABELS, FIELD_SCOPES, isFieldId, type FieldId } from '../../shared/fields';
import { db, type PaperRow } from '../db';
import { parseJsonLoose } from '../json';
import { classifyEngineFailure, describeUnavailable, engineOrder, type EngineUnavailable } from '../llm/fallback';
import { enginesAvailable, runLlm } from '../llm/index';
import { abstractOrPageOne } from '../pdf/context';
import { fill, loadPrompt } from '../prompts';
import { getLastEngine, getSettings, type Engine } from '../settings';

export interface FieldSuggestion {
  suggested: FieldId | null;
  /** The engine that answered; null when the suggestion was already stored. */
  engine: Engine | null;
  /** Engines passed over before `engine` answered. */
  skipped: { engine: Engine; reason: EngineUnavailable }[];
}

/**
 * Ask the last engine that answered (else the selected one) and, only when it is out of usage,
 * signed out or not installed, the other engine. Other failures are reported, not retried.
 */
export async function suggestField(paper: PaperRow): Promise<FieldSuggestion> {
  const fields = FIELDS.map((f) => `- ${f}: ${FIELD_LABELS[f]} — ${FIELD_SCOPES[f]}`).join('\n');
  const prompt = fill(loadPrompt('field').PROMPT, { title: paper.title, abstract: abstractOrPageOne(paper), fields });
  const settings = getSettings();
  const installed = enginesAvailable();
  const skipped: FieldSuggestion['skipped'] = [];
  for (const engine of engineOrder(getLastEngine(), settings.engine)) {
    if (!installed[engine]) {
      skipped.push({ engine, reason: 'missing' });
      continue;
    }
    const profile = settings[engine];
    let text: string;
    try {
      ({ text } = await runLlm({
        system: '너는 연구 논문의 학문 분야를 분류한다. JSON 하나로만 답한다.',
        prompt,
        profile: 'quick',
        model: { engine, model: profile.quickModel, effort: profile.quickEffort },
      }));
    } catch (e) {
      const reason = classifyEngineFailure(e instanceof Error ? e.message : String(e));
      if (!reason) throw e;
      skipped.push({ engine, reason });
      continue;
    }
    let parsed: { field?: unknown } | null;
    try {
      parsed = parseJsonLoose<{ field?: unknown } | null>(text);
    } catch {
      return { suggested: null, engine, skipped };
    }
    if (!isFieldId(parsed?.field)) return { suggested: null, engine, skipped };
    db.prepare('UPDATE papers SET field_suggested=? WHERE id=?').run(parsed.field, paper.id);
    return { suggested: parsed.field, engine, skipped };
  }
  throw new Error(`지금 쓸 수 있는 AI가 없습니다 (${describeUnavailable(skipped)})`);
}
