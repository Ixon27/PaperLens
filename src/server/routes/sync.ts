import { Hono } from 'hono';
import { HttpError } from '../http-error';
import { connectGoogle, disconnectGoogle, syncAvailable, syncNow, syncStatus } from '../sync/service';

export const sync = new Hono();

function desktopOnly() {
  if (!syncAvailable()) throw new HttpError(403, '기기 간 동기화는 데스크톱 앱에서만 쓸 수 있습니다');
}

sync.get('/sync/status', async (c) => c.json(await syncStatus()));
sync.post('/sync/connect', async (c) => {
  desktopOnly();
  return c.json(await connectGoogle());
});
sync.post('/sync/disconnect', async (c) => {
  desktopOnly();
  await disconnectGoogle();
  return c.json(await syncStatus());
});
sync.post('/sync/now', async (c) => {
  desktopOnly();
  void syncNow();
  return c.json(await syncStatus());
});
