import type { ScaledPosition } from 'react-pdf-highlighter-extended';

/**
 * Replacement for the pinned highlighter 8.1.0's internal helper. Its pageNumbers array contains
 * one entry per line, so an N-line highlight gets rendered N+1 times on the same page. Deduplicate
 * page numbers before grouping: one highlight per page, with only that page's line rectangles.
 */
export default function groupHighlightsByPage<T extends { position: ScaledPosition }>(highlights: (T | null | undefined)[]) {
  const grouped: Record<number, T[]> = {};
  for (const highlight of highlights) {
    if (!highlight) continue;
    const { position } = highlight;
    const pages = new Set([position.boundingRect.pageNumber]);
    for (const rect of position.rects) pages.add(rect.pageNumber);
    for (const page of pages) {
      (grouped[page] ??= []).push({
        ...highlight,
        position: { ...position, rects: position.rects.filter((r) => r.pageNumber === page) },
      });
    }
  }
  return grouped;
}
