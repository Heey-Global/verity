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

interface NativePinnedTransport {
  request(
    requestId: string,
    url: string,
    method: string,
    headers: Record<string, string>,
    bodyBase64: string | null,
    tlsPin: string,
    proxyPort: number,
  ): Promise<{ status: number }>;
  cancelRequest(requestId: string): Promise<void>;
}

let active: { key: string; port: number } | null = null;
let operation: Promise<unknown> = Promise.resolve();
let retryAfter = 0;
let lastFailure: { key: string; stage: 'setup' | 'admission' | 'attachment' | 'probe' } | null =
  null;

export function remoteControlFailureForUrl(url: string): string | null {
  const target = new URL(url);
  if (target.protocol === 'wss:') target.protocol = 'https:';
  const key = keyFor(target.origin);
  return key !== null && lastFailure?.key === key ? lastFailure.stage : null;
}

async function probeCore(coreUrl: string, tlsPin: string, port: number): Promise<void> {
  const transport = requireNativeModule<NativePinnedTransport>('VerityPinnedTransport');
  const requestId = `remote-probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      transport.request(requestId, `${coreUrl}/healthz`, 'GET', {}, null, tlsPin, port),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          void Promise.resolve()
            .then(() => transport.cancelRequest(requestId))
            .catch(() => undefined);
          reject(new Error('Remote Core probe timed out.'));
        }, 12_000);
      }),
    ]);
    if (response.status !== 200) throw new Error('Remote Core probe failed.');
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

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
  const selected = operation.then(() => selectPort(url));
  operation = selected.then(
    () => undefined,
    () => undefined,
  );
  return selected;
}

async function selectPort(url: string): Promise<number> {
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
  if (active !== null && active.key !== key) {
    active = null;
    try {
      await requireNativeModule<NativeTunnel>('VerityRemoteControlTunnel').stop();
    } catch {
      // A missing native module leaves the direct route usable.
    }
  }
  const attachment = active;
  if (attachment?.key === key) {
    try {
      if (
        (await requireNativeModule<NativeTunnel>('VerityRemoteControlTunnel').isActive()) &&
        active === attachment &&
        keyFor(target) === key
      )
        return attachment.port;
    } catch {
      // A native module unavailable on this platform leaves the direct route usable.
    }
    if (active === attachment) active = null;
  }
  if (keyFor(target) !== key) {
    try {
      await requireNativeModule<NativeTunnel>('VerityRemoteControlTunnel').stop();
    } catch {
      // A missing native module leaves the direct route usable.
    }
    return 0;
  }
  if (Date.now() < retryAfter) return 0;
  return open(target, key);
}

async function open(coreUrl: string, key: string): Promise<number> {
  const profile = getServerProfile();
  const descriptor = profile?.remoteControl;
  const tlsPin = profile?.endpoints.find((entry) => entry.url === coreUrl)?.tlsPin;
  if (descriptor === undefined || tlsPin === undefined) return 0;
  let admission: Awaited<ReturnType<typeof requestRemoteControlAdmission>> | undefined;
  let tunnelStarted = false;
  let stage: 'setup' | 'admission' | 'attachment' | 'probe' = 'setup';
  try {
    const native = requireNativeModule<NativeTunnel>('VerityRemoteControlTunnel');
    if (!(await native.isSupported())) return 0;
    stage = 'admission';
    admission = await requestRemoteControlAdmission({
      uplinkOrigin: descriptor.uplinkOrigin,
      installationHandle: descriptor.installationHandle,
    });
    stage = 'attachment';
    const dataUrl = new URL(descriptor.uplinkOrigin);
    dataUrl.protocol = 'wss:';
    dataUrl.pathname = '/data';
    const port = await native.start(dataUrl.href, admission.ticket, admission.sessionId, coreUrl);
    tunnelStarted = true;
    stage = 'probe';
    admission.finish();
    admission = undefined;
    if (port < 1 || port > 65_535 || keyFor(coreUrl) !== key) {
      await native.stop();
      return 0;
    }
    // Attachment alone does not prove that the SOCKS stream reaches the pinned Core.
    await probeCore(coreUrl, tlsPin, port);
    if (keyFor(coreUrl) !== key) {
      await native.stop();
      return 0;
    }
    active = { key, port };
    lastFailure = null;
    return port;
  } catch {
    lastFailure = { key, stage };
    admission?.cancel();
    if (tunnelStarted) {
      try {
        await requireNativeModule<NativeTunnel>('VerityRemoteControlTunnel').stop();
      } catch {
        // A failed probe still falls back to the direct pinned connection.
      }
    }
    retryAfter = Date.now() + 15_000;
    return 0;
  }
}
