/**
 * Vault rendering cleanup — port of paper-digest notebook_sync.py `tidy()` (without `unwrap()`).
 * Rules 1–6 touch only lines outside ``` fences and `$$` blocks; rule 7 runs on the whole document.
 */
const CITE_RE = /[ \t]*\[\d+(?:\s*[,;]\s*\d+|\s*[-–—]\s*\d+)*\]/g;
const BOLD_LINE_RE = /^\*\*([^*]+)\*\*[:：]?$/;
const JOSA_RE =
  /\)\s+(의|을|를|은|는|이|가|와|과|로|으로|도|만|에|에서|에게|이나|처럼|보다|부터|까지)(도|는|만|의|나)?(?=[\s,.:;)\]]|$)/g;

/** Apply `fn` to every line outside ``` fences and `$$` display-math blocks. */
export function mapOutsideBlocks(md: string, fn: (line: string, index: number) => string): string {
  let fence = false;
  let math = false;
  return md
    .split('\n')
    .map((line, index) => {
      const st = line.trim();
      if (!math && st.startsWith('```')) {
        fence = !fence;
        return line;
      }
      if (fence) return line;
      if (st.startsWith('$$')) {
        // A single-line `$$ … $$` stays as-is without toggling.
        const single = st.length > 2 && st.endsWith('$$') && st !== '$$';
        if (!single) math = !math;
        return line;
      }
      if (math) return line;
      return fn(line, index);
    })
    .join('\n');
}

export function tidyForVault(md: string): string {
  if (!md) return md;
  const out = mapOutsideBlocks(md, (line) => {
    let l = line.replace(CITE_RE, '');
    const m = BOLD_LINE_RE.exec(l.trim());
    if (m) return '#### ' + m[1].trim();
    l = l.replace(/\*\*\s+\(/g, '**(');
    l = l.replace(JOSA_RE, (_s, a: string, b: string | undefined) => ')' + a + (b ?? ''));
    l = l.replace(/(?<=\S)\*\*(?=[가-힣])/g, '** ');
    l = l.replace(/[ \t]+([,.:;])/g, '$1');
    return l;
  });
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
