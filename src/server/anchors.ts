import { captionLabel, findAnchor, mentionPattern, sectionBody, type ExplainAnchor } from '../shared/explain';
import { getBlocks, type BlockRow } from './db';
import { HttpError } from './http-error';

export type AnchoredBlock = BlockRow & { isRef: boolean };

export interface ResolvedAnchor {
  blocks: AnchoredBlock[];
  block: AnchoredBlock;
  /** The section's body paragraphs; empty for figures and tables. */
  body: AnchoredBlock[];
  /** `Figure 2A` / `Table 1`; null for sections. */
  label: string | null;
}

/** The block an anchor points at in the current layout; 404 when it is gone or no longer that kind. */
export function resolveAnchor(paperId: string, a: ExplainAnchor): ResolvedAnchor {
  const blocks = getBlocks(paperId).map((b) => ({ ...b, isRef: Boolean(b.is_ref) }));
  const at = findAnchor(blocks, a);
  const block = blocks[at];
  const caption = block && a.type !== 'section' ? captionLabel(block.text) : null;
  if (!block || (a.type !== 'section' && caption?.type !== a.type)) throw new HttpError(404, '설명할 위치를 찾을 수 없습니다');
  const body = a.type === 'section' ? sectionBody(blocks, at) : [];
  if (a.type === 'section' && !body.length) throw new HttpError(400, '이 섹션에서 설명할 본문을 찾지 못했습니다');
  return { blocks, block, body, label: caption?.label ?? null };
}

export function figureMentions(r: ResolvedAnchor, limit: number): string {
  const mention = mentionPattern(r.label!);
  return r.blocks
    .filter((b) => b.kind === 'body' && !b.isRef && mention.test(b.text))
    .slice(0, limit)
    .map((b) => `- ${b.text.slice(0, 600)}`)
    .join('\n') || '(본문 언급 없음)';
}
