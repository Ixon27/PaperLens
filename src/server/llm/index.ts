import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { nanoid } from 'nanoid';
import { BIN, PATHS } from '../config';
import { HttpError } from '../http-error';
import { getSettings, type Engine } from '../settings';
import type { ModelSpec } from '../../shared/models';
import { stopCli } from './command';
import { cliSlots } from './semaphore';
import { runClaude } from './claude';
import { runCodex } from './codex';
import { shutdownModelCatalog } from './models';
import { cancelProviderOperations } from '../provider-connect';

export type { Engine, ModelSpec };
export type Profile = 'quick' | 'heavy';

export interface LlmRequest {
  system: string;
  prompt: string;
  imagePath?: string;
  /** Drives the default timeout, and the model when `model` is absent. */
  profile: Profile;
  /** Overrides the settings' model for `profile`. */
  model?: ModelSpec;
  signal?: AbortSignal;
  onDelta?: (t: string) => void;
  /** quick 120_000, heavy 600_000 by default */
  timeoutMs?: number;
}

export interface LlmResult {
  text: string;
  by: ModelSpec;
}

/** What an engine adapter receives: the request plus a scratch cwd and the concrete model. */
export interface EngineCall extends LlmRequest {
  bin: string;
  cwd: string;
  spec: ModelSpec;
  /** Register the spawned child so abort/timeout can kill it. */
  attach(child: ChildProcess): void;
}

export function enginesAvailable(): { claude: boolean; codex: boolean } {
  return { claude: BIN.claude !== null, codex: BIN.codex !== null };
}

/** The settings' model for a profile on the selected engine. */
export function resolveModel(profile: Profile, settings = getSettings()): ModelSpec {
  const engine = settings.engine;
  const p = settings[engine];
  return {
    engine,
    model: profile === 'quick' ? p.quickModel : p.heavyModel,
    effort: profile === 'quick' ? p.quickEffort : p.heavyEffort,
  };
}

/** A client-supplied model choice; model and effort reach CLI arguments, so only plain tokens pass. */
export function validateModelSpec(v: unknown): ModelSpec {
  const bad = () => new HttpError(400, '모델 설정이 올바르지 않습니다');
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw bad();
  const { engine, model, effort } = v as Record<string, unknown>;
  if (engine !== 'claude' && engine !== 'codex') throw bad();
  if (typeof model !== 'string' || typeof effort !== 'string') throw bad();
  const m = model.trim();
  if (m.length > 200 || !/^[\w.:\/\[\]-]*$/.test(m) || (engine === 'claude' && !m)) throw bad();
  if (!/^[a-z]*$/.test(effort)) throw bad();
  if (!BIN[engine]) throw new HttpError(400, '설치되어 있지 않은 CLI입니다');
  return { engine, model: m, effort };
}

const shutdown = new AbortController();
const inFlight = new Set<Promise<void>>();

/** Abort both background jobs and request-scoped chat/selection CLI processes when the app quits. */
export async function shutdownLlm(): Promise<void> {
  shutdown.abort();
  cancelProviderOperations();
  await Promise.all([Promise.all(inFlight), shutdownModelCatalog()]);
}

export async function runLlm(req: LlmRequest): Promise<LlmResult> {
  const spec = req.model ?? resolveModel(req.profile);
  const which = spec.engine;
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
    if (child) stopCli(child);
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
      spec,
      attach: (c) => {
        child = c;
        if (failure) stopCli(c);
      },
    };
    const out = which === 'claude' ? runClaude(call) : runCodex(call);
    try {
      const text = await out;
      if (failure) throw failure;
      return { text, by: spec };
    } catch (e) {
      throw failure ?? e;
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    release();
    inFlight.delete(finished.promise);
    finished.resolve();
    // Windows releases a killed CLI's files a moment after it exits.
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
