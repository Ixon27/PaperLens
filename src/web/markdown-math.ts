const FENCE = /^\s*(```|~~~)/;
const isDelimiter = (line: string) => line.trim() === '$$';

/**
 * Put display-math `$$` delimiters on their own lines. remark-math reads text after an opening
 * `$$` as fence meta and does not close on `…$$`, so `$$\begin{aligned}` … `\end{aligned}$$`
 * would swallow the rest of the document. An unmatched lone `$$` is escaped for the same reason.
 * Code fences and inline `$$x$$` pairs inside a sentence are left alone.
 */
export function normalizeMath(md: string): string {
  const out: string[] = [];
  let fence = false;
  for (const line of md.split('\n')) {
    if (FENCE.test(line)) {
      fence = !fence;
      out.push(line);
      continue;
    }
    const t = line.trim();
    const marks = t.split('$$').length - 1;
    const opens = t.startsWith('$$');
    const closes = t.endsWith('$$');
    const indent = /^\s*/.exec(line)![0];
    if (fence || isDelimiter(line)) out.push(line);
    else if (opens && closes && t.length > 4 && marks === 2) out.push(`${indent}$$`, `${indent}${t.slice(2, -2).trim()}`, `${indent}$$`);
    else if (opens && marks === 1) out.push(`${indent}$$`, `${indent}${t.slice(2).trim()}`);
    else if (closes && marks === 1) out.push(`${indent}${t.slice(0, -2).trim()}`, `${indent}$$`);
    else out.push(line);
  }
  fence = false;
  let last = -1;
  let count = 0;
  out.forEach((line, i) => {
    if (FENCE.test(line)) fence = !fence;
    else if (!fence && isDelimiter(line)) {
      count++;
      last = i;
    }
  });
  if (count % 2 === 1) out[last] = out[last].replace('$$', '\\$\\$');
  return out.join('\n');
}
