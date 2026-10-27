export interface QuoteBlock {
  idx: number;
  page: number;
  text: string;
  isRef: boolean;
}

export interface QuoteHit {
  idx: number;
  start: number;
  end: number;
}

type Skeleton = { chars: string; pos: number[]; ends: number[] };
const cache = new WeakMap<QuoteBlock, Skeleton>();

function skeleton(text: string): Skeleton {
  let chars = '';
  const pos: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < text.length;) {
    const c = String.fromCodePoint(text.codePointAt(i)!);
    const end = i + c.length;
    for (const normalized of c.normalize('NFKC').toLowerCase()) {
      if (!/[\p{L}\p{N}]/u.test(normalized)) continue;
      chars += normalized;
      for (let j = 0; j < normalized.length; j++) {
        pos.push(i);
        ends.push(end);
      }
    }
    i = end;
  }
  return { chars, pos, ends };
}

function blockSkeleton(block: QuoteBlock): Skeleton {
  let result = cache.get(block);
  if (!result) {
    result = skeleton(block.text);
    cache.set(block, result);
  }
  return result;
}

export function findQuote(blocks: QuoteBlock[], page: number, endPage: number | null, quote: string): QuoteHit | null {
  const q = skeleton(quote).chars;
  if (q.length < 12) return null;
  const lastPage = endPage ?? page;
  const eligible = blocks.filter((block) => !block.isRef);
  const tiers = [
    eligible.filter((block) => block.page >= page && block.page <= lastPage),
    eligible.filter((block) => block.page === page - 1 || block.page === lastPage + 1),
    eligible,
  ];
  const fragmentLength = Math.ceil(q.length * 0.6);
  const fragments = [q];
  if (fragmentLength >= 12) fragments.push(q.slice(0, fragmentLength), q.slice(-fragmentLength));
  for (const fragment of fragments) {
    for (const tier of tiers) {
      for (const block of tier) {
        const s = blockSkeleton(block);
        const k = s.chars.indexOf(fragment);
        if (k !== -1) return { idx: block.idx, start: s.pos[k], end: s.ends[k + fragment.length - 1] };
      }
    }
  }
  return null;
}
