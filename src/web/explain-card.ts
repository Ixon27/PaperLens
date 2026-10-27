/** An explanation card answer: `# 제목`, the explanation, then `#### 생각의 확장` with numbered follow-ups. */
export interface ParsedCard {
  title: string | null;
  body: string;
  intro: string;
  questions: string[];
}

const TITLE = /^#\s+(.+?)\s*#*\s*$/;
const EXPAND = /^####\s*생각의 확장/;
const QUESTION = /^\s*\d+[.)]\s+(.+)$/;

export function parseCard(md: string): ParsedCard {
  const lines = md.split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  const m = first >= 0 ? TITLE.exec(lines[first].trim()) : null;
  const title = m ? m[1] : null;
  if (m) lines.splice(first, 1);
  const at = lines.findIndex((l) => EXPAND.test(l));
  const bodyLines = at >= 0 ? lines.slice(0, at) : lines;
  const intro: string[] = [];
  const questions: string[] = [];
  for (const line of at >= 0 ? lines.slice(at + 1) : []) {
    const q = QUESTION.exec(line);
    if (q) questions.push(q[1].trim());
    else if (line.trim()) intro.push(line.trim());
  }
  return { title, body: bodyLines.join('\n').trim(), intro: intro.join(' '), questions };
}
