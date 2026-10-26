import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerType } from '@hono/node-server';
import { startServer } from '../src/server/app';
import { db } from '../src/server/db';
import { getSettings, saveSettings } from '../src/server/settings';

let server: ServerType;
let origin: string;
const token = 'isolated-desktop-session';
beforeAll(async () => {
  server = await startServer({ port: 0, token, production: true });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('desktop backend access', () => {
  it('rejects both API and static document requests without the session credential', async () => {
    expect((await fetch(`${origin}/api/settings`)).status).toBe(401);
    expect((await fetch(origin)).status).toBe(401);
    expect((await fetch(`${origin}/api/settings`, { headers: { Authorization: 'Bearer wrong-session' } })).status).toBe(401);
  });

  it('allows the application but rejects a foreign website even with its credential', async () => {
    const headers = { Authorization: `Bearer ${token}` };
    expect((await fetch(`${origin}/api/settings`, { headers })).status).toBe(200);
    expect((await fetch(`${origin}/api/settings`, { headers: { ...headers, Origin: 'https://untrusted.example' } })).status).toBe(403);
    expect((await fetch(`${origin}/api/no-such-api`, { headers })).status).toBe(404);
  });
});

it('disconnects an existing vault without resetting the saved reader profile', () => {
  const previous = db.prepare("SELECT value FROM settings WHERE key='app'").get() as { value: string } | undefined;
  const vault = mkdtempSync(join(tmpdir(), 'paper-reader-vault-'));
  try {
    saveSettings({ vaultPath: vault, readerContext: 'My saved research profile' });
    saveSettings({ vaultPath: null });
    const restored = getSettings();
    expect(restored.vaultPath).toBeNull();
    expect(restored.readerContext).toBe('My saved research profile');
  } finally {
    if (previous) db.prepare("UPDATE settings SET value=? WHERE key='app'").run(previous.value);
    else db.prepare("DELETE FROM settings WHERE key='app'").run();
    rmSync(vault, { recursive: true, force: true });
  }
});
