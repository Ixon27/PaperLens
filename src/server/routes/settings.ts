import { Hono } from 'hono';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { PATHS } from '../config';
import { enginesAvailable } from '../llm/index';
import { getModelCatalog } from '../llm/models';
import { getSettings, saveSettings } from '../settings';
import { checkForUpdate } from '../update';

export const settings = new Hono();

settings.get('/engines', (c) => c.json(enginesAvailable()));
settings.get('/models', async (c) => c.json(await getModelCatalog()));
settings.get('/settings', (c) => c.json(getSettings()));
settings.put('/settings', async (c) => c.json(saveSettings(await c.req.json())));
settings.get('/update', async (c) => c.json(await checkForUpdate()));

settings.get('/system', (c) => c.json({
  desktop: process.env.PAPER_READER_DESKTOP === '1',
  filesPath: PATHS.files,
  dbPath: PATHS.db,
  vaultPath: getSettings().vaultPath,
  home: homedir(),
  dataDir: dirname(PATHS.db),
}));
