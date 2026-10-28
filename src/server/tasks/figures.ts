import { nanoid } from 'nanoid';
import { anchorId, captionKindName, type ExplainAnchor } from '../../shared/explain';
import { FIELD_LABELS, resolveField } from '../../shared/fields';
import { validateFigureSpec, type FigureKind, type FigureSpec } from '../../shared/figure-spec';
import { figureMentions, resolveAnchor } from '../anchors';
import { db, getPaper, now } from '../db';
import { fieldPrompt } from '../fields';
import { imagePath, removeImage, saveDataUrlPng } from '../images';
import { startJob } from '../jobs';
import { parseJsonLoose } from '../json';
import { resolveModel, runLlm } from '../llm';
import { paperSystem } from '../pdf/context';
import { fill, loadPrompt } from '../prompts';
import { getSettings } from '../settings';

export function startFigure(paperId: string, anchor: ExplainAnchor, imageDataUrl: string, forced: FigureKind | null): string {
  const key = anchorId(anchor);
  return startJob(paperId, 'figure', async (ctx) => {
    const file = saveDataUrlPng(imageDataUrl, `fig-${nanoid(12)}`);
    let committed = false;
    try {
      ctx.progress(0.1, '그림 읽는 중…');
      const paper = getPaper(paperId);
      if (!paper) throw new Error('논문을 찾을 수 없습니다');
      const r = resolveAnchor(paperId, anchor);
      const settings = getSettings();
      const by = resolveModel('heavy', settings);
      const field = resolveField(paper.field, paper.field_suggested);
      const prompt = fill(loadPrompt('figures').PROMPT, {
        title: paper.title,
        context: settings.readerContext,
        field_label: FIELD_LABELS[field],
        field_figures: fieldPrompt(field, 'FIGURES'),
        kind_name: captionKindName(r.label!),
        label: r.label!,
        page: anchor.page,
        caption: r.block.text.slice(0, 1500),
        mentions: figureMentions(r, 5),
        kind_rule: forced ? `kind 는 반드시 "${forced}" 로 만든다.` : '가장 잘 맞는 kind 하나를 골라라.',
      });
      const system = paperSystem(paper, { includeRefs: false });
      const call = async (p: string): Promise<{ spec: FigureSpec } | { error: string }> => {
        const output = await runLlm({ system, prompt: p, imagePath: imagePath(file), profile: 'heavy', model: by, signal: ctx.signal });
        if (ctx.signal.aborted) throw new Error('취소됨');
        let raw: unknown;
        try {
          raw = parseJsonLoose<unknown>(output.text);
        } catch {
          return { error: 'JSON을 파싱할 수 없습니다' };
        }
        const result = validateFigureSpec(raw, paper.page_count ?? 0);
        if ('spec' in result && forced && result.spec.kind !== forced) return { error: `kind 가 ${forced} 가 아닙니다` };
        return result;
      };
      let result = await call(prompt);
      if ('error' in result) {
        ctx.progress(0.6, 'JSON 다시 요청 중…');
        result = await call(prompt + `\n\n(다시. 직전 출력은 쓸 수 없었다: ${result.error}. 설명 없이 JSON 객체 하나만 출력하라.)`);
      }
      if ('error' in result) throw new Error(`그림 위젯을 만들지 못했습니다: ${result.error}`);
      if (ctx.signal.aborted) throw new Error('취소됨');
      const previous = db.prepare('SELECT image_file FROM figures WHERE paper_id=? AND anchor=?').get(paperId, key) as { image_file: string | null } | undefined;
      db.prepare(`INSERT INTO figures(paper_id,anchor,spec,image_file,made_by,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(paper_id,anchor) DO UPDATE SET spec=excluded.spec, image_file=excluded.image_file,
        made_by=excluded.made_by, updated_at=excluded.updated_at`).run(paperId, key, JSON.stringify(result.spec), file, JSON.stringify(by), now());
      committed = true;
      if (previous?.image_file !== file) removeImage(previous?.image_file);
    } catch (e) {
      if (!committed) removeImage(file);
      throw e;
    }
  }, key);
}
