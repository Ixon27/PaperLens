import { getBlocks, type BlockRow, type PaperRow } from '../db';

const CONTEXT_CAP = 350_000;

function render(blocks: BlockRow[]): string {
  const byPage = new Map<number, string[]>();
  for (const b of blocks) {
    const list = byPage.get(b.page) ?? [];
    list.push(b.text);
    byPage.set(b.page, list);
  }
  return [...byPage.entries()].map(([page, texts]) => `[p.${page}]\n` + texts.join('\n\n')).join('\n\n');
}

/** Whole-paper text with `[p.N]` page markers, capped at 350k chars. */
export function paperContext(paperId: string, { includeRefs = true }: { includeRefs?: boolean } = {}): string {
  const blocks = getBlocks(paperId);
  let text = render(includeRefs ? blocks : blocks.filter((b) => !b.is_ref));
  if (text.length > CONTEXT_CAP && includeRefs) text = render(blocks.filter((b) => !b.is_ref));
  if (text.length > CONTEXT_CAP) text = text.slice(0, CONTEXT_CAP) + '\n[이하 생략]';
  return text;
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** System prompt that grounds the model in the paper body. */
export function paperSystem(paper: Pick<PaperRow, 'id' | 'title'>, opts?: { includeRefs?: boolean }): string {
  return (
    '너는 연구 논문을 같이 읽는 조교다. 아래 <paper> 본문만 근거로 쓴다. 페이지는 본문 속 [p.N] 표시를 따른다.\n' +
    `<paper title="${escapeAttr(paper.title)}">\n${paperContext(paper.id, opts)}\n</paper>`
  );
}

/** `papers.abstract`, or the first 1,500 chars of page-1 text. */
export function abstractOrPageOne(paper: Pick<PaperRow, 'id' | 'abstract'>): string {
  if (paper.abstract?.trim()) return paper.abstract.trim();
  return getBlocks(paper.id)
    .filter((b) => b.page === 1)
    .map((b) => b.text)
    .join('\n')
    .slice(0, 1500);
}
