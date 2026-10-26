import { Hono } from 'hono';
import { PATHS } from '../config';
import { enginesAvailable } from '../llm/index';
import { getModelCatalog } from '../llm/models';
import { getSettings, saveSettings } from '../settings';

export const settings = new Hono();

settings.get('/engines', (c) => c.json(enginesAvailable()));
settings.get('/models', async (c) => c.json(await getModelCatalog()));
settings.get('/settings', (c) => c.json(getSettings()));
settings.put('/settings', async (c) => c.json(saveSettings(await c.req.json())));

settings.get('/system', (c) => c.json({
  desktop: process.env.PAPER_READER_DESKTOP === '1',
  filesPath: PATHS.files,
  dbPath: PATHS.db,
  vaultPath: getSettings().vaultPath,
}));
