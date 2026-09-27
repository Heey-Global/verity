import { requireNativeModule } from 'expo-modules-core';

import { getAuthToken } from './authToken';
import { requestRemoteControlAdmission } from './remoteControlAdmission';
import { getServerProfile } from './serverProfile';

interface NativeTunnel {
  isSupported(): Promise<boolean>;
  start(dataUrl: string, ticket: string, sessionId: string, coreUrl: string): Promise<number>;
  isActive(): Promise<boolean>;
  stop(): Promise<void>;
}

let active: { key: string; port: number } | null = null;
let pending: { key: string; promise: Promise<number> } | null = null;
let retryAfter = 0;

function keyFor(url: string): string | null {
  const profile = getServerProfile();
  if (
    profile?.activeUrl !== url ||
    profile.remoteControl === undefined ||
    getAuthToken(url) === null ||
    !profile.endpoints.some((entry) => entry.url === url && entry.transport === 'direct')
  ) {
    return null;
  }
  const remote = profile.remoteControl;
  return `${profile.serverId}:${url}:${remote.installationId}:${remote.installationHandle}:${remote.uplinkOrigin}`;
}

/** Return zero for a direct pinned connection. Admission failure never replays an API request. */
export async function remoteControlPortForUrl(url: string): Promise<number> {
  const targetUrl = new URL(url);
  if (targetUrl.protocol === 'wss:') targetUrl.protocol = 'https:';
  const target = targetUrl.origin;
  const key = keyFor(target);
  if (key === null) {
    if (active !== null) {
      active = null;
      try {
        await requireNativeModule<NativeTunnel>('VerityRemoteControlTunnel').stop();
      } catch {
        // The direct path remains usable if the native module is unavailable.
      }
    }
    return 0;
  }
  if (active?.key === key) {
    try {
      if (await requireNativeModule<NativeTunnel>('VerityRemoteControlTunnel').isActive())
        return active.port;
    } catch {
      // A native module unavailable on this platform leaves the direct route usable.
    }
    active = null;
  }
  if (pending?.key === key) return pending.promise;
  if (Date.now() < retryAfter) return 0;
  const promise = open(target, key);
  pending = { key, promise };
  try {
    return await promise;
  } finally {
    if (pending?.promise === promise) pending = null;
  }
}

async function open(coreUrl: string, key: string): Promise<number> {
  const descriptor = getServerProfile()?.remoteControl;
  if (descriptor === undefined) return 0;
  let admission: Awaited<ReturnType<typeof requestRemoteControlAdmission>> | undefined;
  try {
    const native = requireNativeModule<NativeTunnel>('VerityRemoteControlTunnel');
    if (!(await native.isSupported())) return 0;
    admission = await requestRemoteControlAdmission({
      uplinkOrigin: descriptor.uplinkOrigin,
      installationHandle: descriptor.installationHandle,
    });
    const dataUrl = new URL(descriptor.uplinkOrigin);
    dataUrl.protocol = 'wss:';
    dataUrl.pathname = '/data';
    const port = await native.start(dataUrl.href, admission.ticket, admission.sessionId, coreUrl);
    admission.finish();
    admission = undefined;
    if (port < 1 || port > 65_535 || keyFor(coreUrl) !== key) {
      await native.stop();
      return 0;
    }
    active = { key, port };
    return port;
  } catch {
    admission?.cancel();
    retryAfter = Date.now() + 15_000;
    return 0;
  }
}
