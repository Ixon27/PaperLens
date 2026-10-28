import { Hono } from 'hono';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { PATHS } from '../config';
import { enginesAvailable } from '../llm/index';
import { getModelCatalog } from '../llm/models';
import { getSettings, saveSettings } from '../settings';
import { checkForUpdate } from '../update';
import { HttpError } from '../http-error';
import { cancelProviderOperation, providerStatus, startProviderOperation, submitProviderCode } from '../provider-connect';

function provider(value: string) {
  if (value !== 'claude' && value !== 'codex') throw new HttpError(400, '알 수 없는 AI 서비스입니다');
  return value;
}

function desktopOnly() {
  if (process.env.PAPER_READER_DESKTOP !== '1') throw new HttpError(403, '데스크톱 앱에서만 연결할 수 있습니다');
}

export const settings = new Hono();

settings.get('/engines', (c) => c.json(enginesAvailable()));
settings.get('/models', async (c) => c.json(await getModelCatalog()));
settings.get('/settings', (c) => c.json(getSettings()));
settings.put('/settings', async (c) => c.json(saveSettings(await c.req.json())));
settings.get('/update', async (c) => c.json(await checkForUpdate()));
settings.get('/providers/:engine', async (c) => { desktopOnly(); return c.json(await providerStatus(provider(c.req.param('engine')))); });
settings.post('/providers/:engine/code', async (c) => {
  desktopOnly();
  const engine = provider(c.req.param('engine'));
  const body = await c.req.json();
  try { submitProviderCode(engine, body?.code); }
  catch (e) { throw new HttpError(400, e instanceof Error ? e.message : '인증 코드를 전달하지 못했습니다'); }
  return c.json({ ok: true });
});
settings.post('/providers/:engine/connect', (c) => {
  desktopOnly();
  const engine = provider(c.req.param('engine'));
  try { startProviderOperation(engine); }
  catch (e) { throw new HttpError(400, e instanceof Error ? e.message : '작업을 시작하지 못했습니다'); }
  return c.json({ ok: true });
});
settings.post('/providers/:engine/cancel', (c) => {
  desktopOnly();
  cancelProviderOperation(provider(c.req.param('engine')));
  return c.json({ ok: true });
});

settings.get('/system', (c) => c.json({
  desktop: process.env.PAPER_READER_DESKTOP === '1',
  filesPath: PATHS.files,
  dbPath: PATHS.db,
  vaultPath: getSettings().vaultPath,
  home: homedir(),
  dataDir: dirname(PATHS.db),
}));
