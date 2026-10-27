import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PATHS } from '../src/server/config';
import { fill, loadPrompt } from '../src/server/prompts';

it('loads and fills prompt sections with Windows line endings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paperlens-prompts-'));
  const previous = PATHS.prompts;
  try {
    PATHS.prompts = dir;
    writeFileSync(join(dir, 'fixture.md'), '<!-- header -->\r\n## === SYSTEM ===\r\nRead {title}.\r\n## === PROMPT ===\r\nExplain {text}.\r\n');
    const prompt = loadPrompt('fixture');
    expect(fill(prompt.SYSTEM, { title: 'Paper' })).toBe('Read Paper.');
    expect(fill(prompt.PROMPT, { text: 'results' })).toBe('Explain results.');
  } finally {
    PATHS.prompts = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
