import { Hono } from 'hono';
import { enginesAvailable } from '../llm/index';
import { getSettings, saveSettings } from '../settings';

export const settings = new Hono();

settings.get('/engines', (c) => c.json(enginesAvailable()));
settings.get('/settings', (c) => c.json(getSettings()));
settings.put('/settings', async (c) => c.json(saveSettings(await c.req.json())));
