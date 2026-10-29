import type { Engine } from '../settings';

/** Why an engine cannot answer right now; only these failures move a request to the other engine. */
export type EngineUnavailable = 'usage' | 'auth' | 'missing';

const USAGE = [
  /hit your [\w' -]*limit/i, // Claude: session/weekly/model/spend limits; Codex: "You've hit your usage limit"
  /usage[ _-]limit/i,
  /rate[ _-]limit/i,
  /\b429\b/,
  /too many requests/i,
  /credit balance is too low/i,
  /spend limit/i,
  /insufficient[ _-]quota/i,
  /quota (?:exceeded|reached)/i,
  /temporarily limiting requests/i,
];
const AUTH = [
  /not logged in/i,
  /run \/login/i,
  /login expired/i,
  /authentication required/i,
  /sign in again/i,
  /\b401\b/,
  /unauthori[sz]ed/i,
  /invalid api key/i,
  /oauth token (?:revoked|has expired)/i,
  /does not have access to claude/i,
  /codex login/i,
];

/** Classify a CLI failure message; null for everything else (timeouts, bad output, cancellation). */
export function classifyEngineFailure(message: string): Exclude<EngineUnavailable, 'missing'> | null {
  if (USAGE.some((re) => re.test(message))) return 'usage';
  if (AUTH.some((re) => re.test(message))) return 'auth';
  return null;
}

/** The last engine that answered first, else the selected one; then the other engine. */
export function engineOrder(last: Engine | null, selected: Engine): [Engine, Engine] {
  const first = last ?? selected;
  return [first, first === 'claude' ? 'codex' : 'claude'];
}

export const ENGINE_NAMES: Record<Engine, string> = { claude: 'Claude', codex: 'Codex' };

const REASONS: Record<EngineUnavailable, string> = { usage: '사용량 한도', auth: '로그인 필요', missing: '설치 안 됨' };

/** `Claude: 사용량 한도, Codex: 로그인 필요` */
export function describeUnavailable(skipped: { engine: Engine; reason: EngineUnavailable }[]): string {
  return skipped.map((s) => `${ENGINE_NAMES[s.engine]}: ${REASONS[s.reason]}`).join(', ');
}
