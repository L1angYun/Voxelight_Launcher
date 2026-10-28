import type { Account } from '../lib/launcher';
import { LauncherError } from '../lib/errors';

export interface DeviceLogin {
  sessionId: string; userCode: string; verificationUri: string;
  expiresIn: number; interval: number; message: string;
}
export interface DevicePoll { status: 'pending' | 'slowDown' | 'complete'; retryAfterSeconds: number; account: Account | null; }
export interface AuthlibProfile { id: string; name: string; }
export interface AuthlibLogin { status: 'selectProfile' | 'complete'; sessionId: string | null; profiles: AuthlibProfile[]; account: Account | null; }

export function cancelled() { return new DOMException('登录已取消', 'AbortError'); }
export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(cancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** No credential is returned by IPC. Respect both the initial interval and later server backoff. */
export async function waitForMicrosoftLogin(
  login: DeviceLogin,
  poll: (sessionId: string) => Promise<DevicePoll>,
  signal: AbortSignal,
  options: { deadline?: number; now?: () => number; delay?: typeof abortableDelay; onBackoff?: (seconds: number) => void } = {},
): Promise<Account> {
  const now = options.now ?? Date.now;
  const delay = options.delay ?? abortableDelay;
  const deadline = options.deadline ?? now() + login.expiresIn * 1000;
  let interval = Math.max(1, login.interval);
  while (!signal.aborted) {
    if (now() >= deadline) throw new LauncherError('auth.deviceExpired', {}, '设备代码已过期，请重新开始登录。');
    options.onBackoff?.(interval);
    await delay(Math.min(interval * 1000, Math.max(0, deadline - now())), signal);
    if (signal.aborted) throw cancelled();
    if (now() >= deadline) throw new LauncherError('auth.deviceExpired', {}, '设备代码已过期，请重新开始登录。');
    const result = await poll(login.sessionId);
    if (signal.aborted) throw cancelled();
    if (result.status === 'complete') {
      if (!result.account) throw new LauncherError('auth.invalidResponse', {}, '认证响应缺少角色，未添加账号，请重新登录。');
      return result.account;
    }
    if (result.status !== 'pending' && result.status !== 'slowDown') throw new LauncherError('auth.invalidResponse', {}, '无法识别认证状态，请重新开始登录。');
    interval = Math.max(1, result.retryAfterSeconds || interval);
  }
  throw cancelled();
}
