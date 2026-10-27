export function pageCiteRe(): RegExp {
  return /\[p\.(\d+)(?:[–-](\d+))?(?:\s+["“]([^"“”\[\]\n]{1,300})["”])?\]/g;
}

export function linkPageCites(text: string): string {
  return text.replace(pageCiteRe(), (_match, a: string, b: string | undefined, quote: string | undefined) => {
    const label = `p.${a}${b ? `–${b}` : ''}`;
    const encodedQuote = quote === undefined ? '' : `~${encodeURIComponent(quote.trim()).replace(/[()]/g, (c) => c === '(' ? '%28' : '%29')}`;
    return `[${label}](#p-${a}${b ? `-${b}` : ''}${encodedQuote})`;
  });
}

export function parsePageHref(href: string): { page: number; endPage: number | null; quote: string | null } | null {
  const match = /^#p-(\d+)(?:-(\d+))?(?:~(.*))?$/.exec(href);
  if (!match) return null;
  try {
    return {
      page: Number(match[1]),
      endPage: match[2] === undefined ? null : Number(match[2]),
      quote: match[3] === undefined ? null : decodeURIComponent(match[3]),
    };
  } catch {
    return null;
  }
}

export function pageCites(md: string): { page: number; endPage: number | null; quote: string | null }[] {
  return Array.from(md.matchAll(pageCiteRe()), (match) => ({
    page: Number(match[1]),
    endPage: match[2] === undefined ? null : Number(match[2]),
    quote: match[3] === undefined ? null : match[3].trim(),
  }));
}
