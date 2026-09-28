import { requireNativeModule } from 'expo-modules-core';

import { getAuthToken } from './authToken';
import { requestRemoteControlAdmission } from './remoteControlAdmission';
import { getServerProfile } from './serverProfile';

interface NativeTunnel {
  isSupported(): Promise<boolean>;
  start(dataUrl: string, ticket: string, sessionId: string, coreUrl: string): Promise<number>;
  isActive(): Promise<boolean>;
  stop(): Promise<void>;
  /** Absent in native builds older than the JavaScript bundle. */
  lastStopReason?(): Promise<string | null>;
  /** Available in builds with native stream diagnostics. */
  diagnosticSummary?(): Promise<string | null>;
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
// Uplink is the fallback for when the paired address cannot be reached, not a
// replacement for it: relaying every request through the hosted service made
// the app far slower on the very network (VPN, LAN) where it used to be fast.
const DIRECT_PROBE_TIMEOUT_MS = 3_000;
const DIRECT_ROUTE_TTL_MS = 30_000;
let directRoute: { key: string; reachable: boolean; checkedAt: number } | null = null;
let directProbe: { key: string; promise: Promise<boolean> } | null = null;
let lastFailure: {
  key: string;
  stage: 'setup' | 'admission' | 'attachment' | 'probe';
  detail: string | null;
} | null = null;

export function remoteControlFailureForUrl(url: string): string | null {
  const target = new URL(url);
  if (target.protocol === 'wss:') target.protocol = 'https:';
  const key = keyFor(target.origin);
  if (key === null) {
    const profile = getServerProfile();
    if (profile?.activeUrl !== target.origin) return 'routing (no matching paired endpoint)';
    if (getAuthToken(target.origin) === null) return 'routing (missing device authentication)';
    if (profile.remoteControl === undefined) return 'routing (no remote descriptor saved)';
    return 'routing (no direct pinned endpoint)';
  }
  if (lastFailure?.key !== key) return null;
  return lastFailure.detail === null
    ? lastFailure.stage
    : `${lastFailure.stage} (${lastFailure.detail})`;
}

// The native tunnel's own account of why it ended. Without it every drop reads
// as the same "native transport error", which is how an idle timeout went
// unnoticed for several releases. Clipped and flattened: it lands in an error
// message shown on screen.
async function tunnelStopReason(): Promise<string | null> {
  try {
    const native = requireNativeModule<NativeTunnel>('VerityRemoteControlTunnel');
    if (typeof native.lastStopReason !== 'function') return null;
    const reason = await native.lastStopReason();
    if (typeof reason !== 'string' || reason.length === 0) return null;
    return reason.replace(/\s+/gu, ' ').slice(0, 160);
  } catch {
    return null;
  }
}

async function tunnelDiagnosticSummary(): Promise<string | null> {
  try {
    const native = requireNativeModule<NativeTunnel>('VerityRemoteControlTunnel');
    if (typeof native.diagnosticSummary !== 'function') return null;
    const summary = await native.diagnosticSummary();
    return typeof summary === 'string' &&
      /^local=\d+, opened=\d+, received=\d+, last=[a-z_.]+$/u.test(summary)
      ? summary
      : null;
  } catch {
    return null;
  }
}

/** A direct request failed at the network level; route the next ones through Uplink. */
export function reportDirectRouteFailure(url: string): void {
  const target = new URL(url);
  if (target.protocol === 'wss:') target.protocol = 'https:';
  const key = keyFor(target.origin);
  if (key !== null) directRoute = { key, reachable: false, checkedAt: Date.now() };
}

async function probeCore(
  coreUrl: string,
  tlsPin: string,
  port: number,
  timeoutMs = 12_000,
): Promise<void> {
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
        }, timeoutMs);
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

/** An explicit diagnostic uses Uplink even when the direct route is healthy. */
export async function testRemoteControlForUrl(
  url: string,
): Promise<{ ready: boolean; detail: string }> {
  const selected = operation.then(async () => {
    const target = new URL(url).origin;
    const key = keyFor(target);
    if (key === null) {
      return { ready: false, detail: remoteControlFailureForUrl(target) ?? 'route unavailable' };
    }
    const attachment = active;
    if (attachment?.key === key) {
      try {
        if (await requireNativeModule<NativeTunnel>('VerityRemoteControlTunnel').isActive()) {
          const pin = getServerProfile()?.endpoints.find((entry) => entry.url === target)?.tlsPin;
          if (pin !== undefined) {
            await probeCore(target, pin, attachment.port);
            return { ready: true, detail: 'Core health check passed through Uplink' };
          }
        }
      } catch (error) {
        // A diagnostic must not replace a tunnel that may be carrying transfers.
        const summary = await tunnelDiagnosticSummary();
        return {
          ready: false,
          detail: `probe (${safeRemoteFailure(error) ?? 'Core did not answer'}${summary ? `; tunnel ${summary}` : ''})`,
        };
      }
    }
    const port = await open(target, key);
    return port > 0
      ? { ready: true, detail: 'Core health check passed through Uplink' }
      : { ready: false, detail: remoteControlFailureForUrl(target) ?? 'connection failed' };
  });
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
  if (await directRouteReachable(target, key)) {
    if (active !== null && active.key !== key) {
      active = null;
      try {
        await requireNativeModule<NativeTunnel>('VerityRemoteControlTunnel').stop();
      } catch {
        // A missing native module leaves the direct route usable.
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
    if (active === attachment) {
      active = null;
      const reason = await tunnelStopReason();
      console.warn(`Remote Control tunnel ended: ${reason ?? 'no reason reported'}`);
    }
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

async function directRouteReachable(coreUrl: string, key: string): Promise<boolean> {
  const known = directRoute?.key === key ? directRoute : null;
  if (known !== null && Date.now() - known.checkedAt < DIRECT_ROUTE_TTL_MS) return known.reachable;
  const probe =
    directProbe?.key === key
      ? directProbe.promise
      : probeDirect(coreUrl, key).finally(() => {
          if (directProbe?.key === key) directProbe = null;
        });
  if (directProbe?.key !== key) directProbe = { key, promise: probe };
  // While a live tunnel carries traffic, look for the direct route without
  // stalling requests on it; the next request after it answers switches back.
  if (known?.reachable === false && active?.key === key) return false;
  return probe;
}

async function probeDirect(coreUrl: string, key: string): Promise<boolean> {
  const previousRoute = directRoute;
  const tlsPin = getServerProfile()?.endpoints.find((entry) => entry.url === coreUrl)?.tlsPin;
  let reachable = false;
  let reason: string | null = null;
  const startedAt = Date.now();
  if (tlsPin !== undefined) {
    try {
      await probeCore(coreUrl, tlsPin, 0, DIRECT_PROBE_TIMEOUT_MS);
      reachable = true;
    } catch (error) {
      reason = safeRemoteFailure(error) ?? 'direct probe failed';
    }
  }
  if (keyFor(coreUrl) === key && directRoute === previousRoute)
    directRoute = { key, reachable, checkedAt: Date.now() };
  console.info('Remote Control direct probe', {
    reachable,
    reason,
    elapsedMs: Date.now() - startedAt,
  });
  return reachable;
}

async function open(coreUrl: string, key: string): Promise<number> {
  const profile = getServerProfile();
  const descriptor = profile?.remoteControl;
  const tlsPin = profile?.endpoints.find((entry) => entry.url === coreUrl)?.tlsPin;
  if (descriptor === undefined || tlsPin === undefined) return 0;
  let admission: Awaited<ReturnType<typeof requestRemoteControlAdmission>> | undefined;
  let tunnelStarted = false;
  const startedAt = Date.now();
  let stage: 'setup' | 'admission' | 'attachment' | 'probe' = 'setup';
  try {
    const native = requireNativeModule<NativeTunnel>('VerityRemoteControlTunnel');
    if (!(await native.isSupported())) throw new Error('Remote tunnel unsupported.');
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
    console.info('Remote Control ready', { elapsedMs: Date.now() - startedAt });
    return port;
  } catch (error) {
    const detail =
      (stage === 'attachment' ? await tunnelStopReason() : null) ?? safeRemoteFailure(error);
    const summary = stage === 'probe' ? await tunnelDiagnosticSummary() : null;
    lastFailure = {
      key,
      stage,
      detail: summary ? `${detail ?? 'unclassified failure'}; tunnel ${summary}` : detail,
    };
    console.warn(`Remote Control ${stage} failed: ${detail ?? 'unclassified failure'}`);
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

/** Only transport codes and local fixed messages may enter diagnostics. */
function safeRemoteFailure(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const message = error.message;
  if (
    /^Remote admission failed: (unavailable|rate_limited|limit_reached|protocol_unsupported|timeout|cancelled|internal)\.$/u.test(
      message,
    )
  )
    return message;
  if (
    /^(Remote admission (timed out|connection failed|connection closed|cancelled)|Invalid remote admission response|Remote Core probe (timed out|failed)|Remote tunnel unsupported)\.$/u.test(
      message,
    )
  )
    return message;
  return (
    message.match(
      /Pinned TLS (?:transport|verification) failed \[[A-Za-z0-9_:.-]{1,150}\]/u,
    )?.[0] ?? null
  );
}
