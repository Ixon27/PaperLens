import { spawnCli } from './command';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { EngineCall } from './index';

interface StreamLine {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
}

export function runClaude(call: EngineCall): Promise<string> {
  const { spec, cwd } = call;
  const systemFile = join(cwd, 'system.txt');
  writeFileSync(systemFile, call.system);
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', spec.model,
    '--tools', '',
    '--no-session-persistence',
    '--setting-sources', 'project',
    // Tools are off, so the user's MCP servers and skills would only slow every start.
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands',
    '--system-prompt-file', systemFile,
  ];
  if (spec.effort) args.push('--effort', spec.effort);
  if (call.imagePath) args.push('--input-format', 'stream-json');

  const child = spawnCli(call.bin, args, { cwd });
  call.attach(child);

  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let stderr = '';
  let settled = false;
  const settle = (fn: () => void) => {
    if (!settled) {
      settled = true;
      fn();
    }
  };

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => {
    stderr = (stderr + d).slice(-4000);
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    let msg: StreamLine;
    try {
      msg = JSON.parse(line) as StreamLine;
    } catch {
      return;
    }
    if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
      call.onDelta?.(msg.event.delta.text ?? '');
    } else if (msg.type === 'result') {
      if (msg.is_error || msg.subtype !== 'success') settle(() => reject(new Error(msg.result || msg.subtype || 'claude 오류')));
      else settle(() => resolve(msg.result ?? ''));
    }
  });
  child.on('error', (e) => settle(() => reject(e)));
  child.on('close', (code) => {
    settle(() => reject(new Error(`claude 실패${code === 0 ? '' : ` (exit ${code})`}: ` + stderr.slice(-300))));
  });

  child.stdin.on('error', () => {}); // EPIPE when the CLI dies early; surfaced via close
  if (call.imagePath) {
    const data = readFileSync(call.imagePath).toString('base64');
    const userLine = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
          { type: 'text', text: call.prompt },
        ],
      },
    };
    child.stdin.end(JSON.stringify(userLine) + '\n');
  } else {
    child.stdin.end(call.prompt);
  }
  return promise;
}
