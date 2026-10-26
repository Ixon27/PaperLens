import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineCall } from './index';

/** codex exec has no streaming text output we rely on and no system-prompt flag. */
export function runCodex(call: EngineCall): Promise<string> {
  const { settings, profile, cwd } = call;
  const outFile = join(cwd, 'out.txt');
  const effort = profile === 'quick' ? settings.codex.quickEffort : settings.codex.heavyEffort;
  const args = [
    'exec',
    '--ignore-user-config',
    '--skip-git-repo-check',
    '--ephemeral',
    '--sandbox', 'read-only',
    '--color', 'never',
    '-C', cwd,
    '-m', settings.codex.model,
    '-c', `model_reasoning_effort="${effort}"`,
    '-o', outFile,
  ];
  if (call.imagePath) args.push('-i', call.imagePath);
  args.push('-');

  const child = spawn(call.bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  call.attach(child);

  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => {
    stderr = (stderr + d).slice(-4000);
  });
  child.stdout.resume();
  child.on('error', reject);
  child.on('close', (code) => {
    const out = existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : '';
    if (code === 0 && out) resolve(out);
    else if (code === 0) reject(new Error('codex 응답 없음: ' + stderr.slice(-300)));
    else reject(new Error(`codex 실패 (exit ${code}): ` + stderr.slice(-300)));
  });
  child.stdin.on('error', () => {});
  child.stdin.end(call.system + '\n\n---\n\n' + call.prompt);
  return promise;
}
