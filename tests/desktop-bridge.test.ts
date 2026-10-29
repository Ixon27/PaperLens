import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBridgeRequest } from '../src/desktop/protocol';
import type { BridgeRequest } from '../src/desktop/protocol';
import { createBridgeClient } from '../src/server/desktop-bridge';

describe('bridge client', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function setup(timeoutMs = 15_000) {
    const sent: BridgeRequest[] = [];
    const client = createBridgeClient((m) => { sent.push(m); }, timeoutMs);
    return { sent, client };
  }

  it('matches results to requests by id, even out of order', async () => {
    const { sent, client } = setup();
    const first = client.bridge.loadSecret('google');
    const second = client.bridge.saveSecret('google', 'secret');
    expect(sent).toEqual([
      { type: 'bridge', id: 1, op: 'loadSecret', name: 'google' },
      { type: 'bridge', id: 2, op: 'saveSecret', name: 'google', value: 'secret' },
    ]);
    client.handleResult({ type: 'bridgeResult', id: 2, ok: true, value: null });
    client.handleResult({ type: 'bridgeResult', id: 1, ok: true, value: 'stored' });
    await expect(first).resolves.toBe('stored');
    await expect(second).resolves.toBeUndefined();
  });

  it('treats a missing value as null and ignores unknown ids', async () => {
    const { client } = setup();
    const pending = client.bridge.loadSecret('google');
    client.handleResult({ type: 'bridgeResult', id: 99, ok: true, value: 'stray' });
    client.handleResult({ type: 'bridgeResult', id: 1, ok: true });
    await expect(pending).resolves.toBeNull();
  });

  it('propagates the parent error message', async () => {
    const { client } = setup();
    const pending = client.bridge.openExternal('https://example.com/');
    client.handleResult({ type: 'bridgeResult', id: 1, ok: false, error: '열 수 없는 주소입니다' });
    await expect(pending).rejects.toThrow('열 수 없는 주소입니다');
    const fallback = client.bridge.clearSecret('google');
    client.handleResult({ type: 'bridgeResult', id: 2, ok: false });
    await expect(fallback).rejects.toThrow('데스크톱 요청이 실패했습니다');
  });

  it('times out and drops a late answer', async () => {
    const { client } = setup(15_000);
    const pending = client.bridge.loadSecret('google');
    const rejected = expect(pending).rejects.toThrow('데스크톱 앱이 응답하지 않습니다');
    vi.advanceTimersByTime(14_999);
    let settled = false;
    void pending.catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1);
    await rejected;
    expect(() => client.handleResult({ type: 'bridgeResult', id: 1, ok: true, value: 'late' })).not.toThrow();
  });

  it('rejects when posting fails and when closed', async () => {
    const failing = createBridgeClient(() => { throw new Error('channel closed'); });
    await expect(failing.bridge.loadSecret('google')).rejects.toThrow('channel closed');
    const { client } = setup();
    const pending = client.bridge.loadSecret('google');
    client.close();
    await expect(pending).rejects.toThrow('데스크톱 앱 연결이 끊어졌습니다');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('parseBridgeRequest', () => {
  it('accepts every valid operation', () => {
    for (const request of [
      { type: 'bridge', id: 1, op: 'loadSecret', name: 'google' },
      { type: 'bridge', id: 2, op: 'saveSecret', name: 'google', value: 'v' },
      { type: 'bridge', id: 3, op: 'clearSecret', name: 'google' },
      { type: 'bridge', id: 4, op: 'openExternal', url: 'https://example.com/' },
    ]) expect(parseBridgeRequest(request)).toEqual({ ok: true, request });
  });

  it('rejects unknown operations and bad shapes but keeps a usable id', () => {
    expect(parseBridgeRequest({ type: 'bridge', id: 5, op: 'rmrf' })).toEqual({ ok: false, id: 5, error: '알 수 없는 데스크톱 요청입니다' });
    expect(parseBridgeRequest({ type: 'bridge', id: 6, op: 'loadSecret', name: 'other' })).toMatchObject({ ok: false, id: 6 });
    expect(parseBridgeRequest({ type: 'bridge', id: 7, op: 'saveSecret', name: 'google' })).toMatchObject({ ok: false, id: 7 });
    expect(parseBridgeRequest({ type: 'bridge', id: 8, op: 'openExternal', url: 42 })).toMatchObject({ ok: false, id: 8 });
    expect(parseBridgeRequest({ type: 'bridge', id: 1.5, op: 'loadSecret', name: 'google' })).toMatchObject({ ok: false, id: null });
    expect(parseBridgeRequest(null)).toMatchObject({ ok: false, id: null });
  });
});
