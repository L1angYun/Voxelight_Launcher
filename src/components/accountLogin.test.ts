import { describe, expect, it, vi } from 'vitest';
import { abortableDelay, waitForMicrosoftLogin, type DeviceLogin } from './accountLogin';
import type { Account } from '../lib/launcher';

const device: DeviceLogin = { sessionId: 'test-session', userCode: 'TEST-CODE', verificationUri: 'https://microsoft.com/devicelogin', expiresIn: 900, interval: 5, message: 'Test device authorization' };
const account: Account = { id: 'test-account', username: 'TestPlayer', uuid: 'test-uuid', type: 'microsoft', isSelected: true };

describe('Microsoft device-code IPC polling', () => {
  it('honors the initial interval and each pending/slow_down response', async () => {
    const poll = vi.fn().mockResolvedValueOnce({ status: 'pending', retryAfterSeconds: 5, account: null })
      .mockResolvedValueOnce({ status: 'slowDown', retryAfterSeconds: 10, account: null })
      .mockResolvedValueOnce({ status: 'complete', retryAfterSeconds: 0, account });
    const delay = vi.fn().mockResolvedValue(undefined);
    expect(await waitForMicrosoftLogin(device, poll, new AbortController().signal, { now: () => 0, delay })).toEqual(account);
    expect(delay.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([5000, 5000, 10000]);
    expect(poll.mock.calls).toEqual([['test-session'], ['test-session'], ['test-session']]);
  });

  it('does not poll expired device codes', async () => {
    const poll = vi.fn();
    await expect(waitForMicrosoftLogin(device, poll, new AbortController().signal, { deadline: 100, now: () => 100 })).rejects.toMatchObject({ code: 'auth.deviceExpired' });
    expect(poll).not.toHaveBeenCalled();
  });

  it('discards late IPC success after cancellation', async () => {
    const controller = new AbortController();
    const poll = vi.fn(async () => { controller.abort(); return { status: 'complete' as const, retryAfterSeconds: 0, account }; });
    await expect(waitForMicrosoftLogin(device, poll, controller.signal, { now: () => 0, delay: async () => {} })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not accept a complete status without an authenticated account', async () => {
    const poll = vi.fn().mockResolvedValue({ status: 'complete', retryAfterSeconds: 0, account: null });
    await expect(waitForMicrosoftLogin(device, poll, new AbortController().signal, { now: () => 0, delay: async () => {} })).rejects.toThrow('缺少角色');
  });

  it('reports network errors without pretending login succeeded', async () => {
    const poll = vi.fn().mockRejectedValue(new Error('认证网络请求失败'));
    await expect(waitForMicrosoftLogin(device, poll, new AbortController().signal, { now: () => 0, delay: async () => {} })).rejects.toThrow('认证网络');
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('aborts a waiting timer promptly', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const waiting = abortableDelay(30000, controller.signal);
      const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort();
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
