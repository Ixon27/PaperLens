import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from './config';

/** Read prompts/<name>.md fresh on every call and split it into `## === NAME ===` sections. */
export function loadPrompt(name: string): Record<string, string> {
  const raw = readFileSync(join(PATHS.prompts, `${name}.md`), 'utf8').replace(/^\s*<!--[\s\S]*?-->/, '');
  const sections: Record<string, string> = {};
  let current: string | null = null;
  let buf: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^## === (.+?) ===$/.exec(line);
    if (m) {
      if (current !== null) sections[current] = buf.join('\n').trim();
      current = m[1];
      buf = [];
    } else if (current !== null) {
      buf.push(line);
    }
  }
  if (current !== null) sections[current] = buf.join('\n').trim();
  return sections;
}

/** Replace `{lower_snake}` placeholders only; anything else (JSON, `{카테고리 이름}`) stays. */
export function fill(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{([a-z_]+)\}/g, (_, key: string) => {
    if (!(key in vars)) throw new Error(`프롬프트 치환자 누락: {${key}}`);
    return String(vars[key]);
  });
}
