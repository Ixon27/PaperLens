import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { nanoid } from 'nanoid';
import { BIN, PATHS } from '../config';
import { getSettings, type Engine, type Settings } from '../settings';
import { cliSlots } from './semaphore';
import { runClaude } from './claude';
import { runCodex } from './codex';
import { shutdownModelCatalog } from './models';

export type { Engine };
export type Profile = 'quick' | 'heavy';

export interface LlmRequest {
  system: string;
  prompt: string;
  imagePath?: string;
  profile: Profile;
  signal?: AbortSignal;
  onDelta?: (t: string) => void;
  /** quick 120_000, heavy 600_000 by default */
  timeoutMs?: number;
}

/** What an engine adapter receives: the request plus a scratch cwd and resolved settings. */
export interface EngineCall extends LlmRequest {
  bin: string;
  cwd: string;
  settings: Settings;
  /** Register the spawned child so abort/timeout can kill it. */
  attach(child: ChildProcess): void;
}

export function enginesAvailable(): { claude: boolean; codex: boolean } {
  return { claude: BIN.claude !== null, codex: BIN.codex !== null };
}

const shutdown = new AbortController();
const inFlight = new Set<Promise<void>>();

/** Abort both background jobs and request-scoped chat/selection CLI processes when the app quits. */
export async function shutdownLlm(): Promise<void> {
  shutdown.abort();
  await Promise.all([Promise.all(inFlight), shutdownModelCatalog()]);
}

export async function runLlm(req: LlmRequest, engine?: Engine): Promise<string> {
  const settings = getSettings();
  const which = engine ?? settings.engine;
  const bin = BIN[which];
  if (!bin) throw new Error(`${which} CLI를 찾을 수 없습니다`);
  const signal = req.signal ? AbortSignal.any([req.signal, shutdown.signal]) : shutdown.signal;
  if (signal.aborted) throw new Error('취소됨');

  const release = await cliSlots.acquire(signal);
  if (signal.aborted) {
    release();
    throw new Error('취소됨');
  }
  const cwd = join(PATHS.tmp, `cli-${nanoid()}`);
  try {
    mkdirSync(cwd, { recursive: true });
  } catch (error) {
    release();
    throw error;
  }
  const finished = Promise.withResolvers<void>();
  inFlight.add(finished.promise);
  let child: ChildProcess | null = null;
  let failure: Error | null = null;
  const kill = (reason: string) => {
    failure ??= new Error(reason);
    child?.kill('SIGTERM');
  };
  const onAbort = () => kill('취소됨');
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => kill('시간 초과'), req.timeoutMs ?? (req.profile === 'heavy' ? 600_000 : 120_000));

  try {
    const call: EngineCall = {
      ...req,
      signal,
      bin,
      cwd,
      settings,
      attach: (c) => {
        child = c;
        if (failure) c.kill('SIGTERM');
      },
    };
    const out = which === 'claude' ? runClaude(call) : runCodex(call);
    try {
      const text = await out;
      if (failure) throw failure;
      return text;
    } catch (e) {
      throw failure ?? e;
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    release();
    inFlight.delete(finished.promise);
    finished.resolve();
    rmSync(cwd, { recursive: true, force: true });
  }
}
