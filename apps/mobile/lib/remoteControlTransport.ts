import { requireNativeModule } from 'expo-modules-core';
import { AppState } from 'react-native';

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
  /** Older native builds cancel without returning the request-specific TLS phase. */
  cancelRequest(requestId: string): Promise<string | null | void>;
  /** Absent in native builds that only speak SOCKS to the loopback tunnel. */
  setProxyMode?(mode: ProxyMode): Promise<void>;
}

type ProxyMode = 'socks' | 'connect';
// A device's URLSession may abandon the pinned handshake through one loopback
// proxy dialect and complete it through the other; the two take different
// paths through the system proxy code. Whichever answered is kept for the rest
// of the process.
let proxyMode: ProxyMode = 'socks';

class ProbeFallbackFailure extends Error {
  constructor(
    readonly first: unknown,
    readonly second: unknown,
    readonly other: ProxyMode,
  ) {
    super('Remote Core probe failed through both proxy dialects.');
  }
}

async function probeCoreThroughEitherProxy(
  coreUrl: string,
  tlsPin: string,
  port: number,
): Promise<void> {
  const transport = requireNativeModule<NativePinnedTransport>('VerityPinnedTransport');
  try {
    await probeCore(coreUrl, tlsPin, port);
  } catch (error) {
    if (typeof transport.setProxyMode !== 'function') throw error;
    const other: ProxyMode = proxyMode === 'socks' ? 'connect' : 'socks';
    await transport.setProxyMode(other);
    try {
      await probeCore(coreUrl, tlsPin, port);
    } catch (otherError) {
      await transport.setProxyMode(proxyMode).catch(() => undefined);
      throw new ProbeFallbackFailure(error, otherError, other);
    }
    proxyMode = other;
    console.info('Remote Control proxy dialect switched', { proxyMode });
  }
}

function probeFailureDetail(error: unknown): string | null {
  if (!(error instanceof ProbeFallbackFailure)) return safeRemoteFailure(error);
  const first = safeRemoteFailure(error.first);
  const second = safeRemoteFailure(error.second);
  if (first === null && second === null) return null;
  return `${first ?? 'unclassified failure'}; via ${error.other} ${second ?? 'unclassified failure'}`;
}

let active: { key: string; port: number } | null = null;
let operation: Promise<unknown> = Promise.resolve();
let retryAfter = 0;
// Uplink is the fallback for when the paired address cannot be reached, not a
// replacement for it: relaying every request through the hosted service made
// the app far slower on the very network (VPN, LAN) where it used to be fast.
const DIRECT_PROBE_TIMEOUT_MS = 3_000;
// A VPN may need a moment after resume; one failure must not hide it for 30 seconds.
const DIRECT_FAILURE_TTL_MS = 3_000;
const DIRECT_ROUTE_TTL_MS = 30_000;
let directRoute: { key: string; reachable: boolean; checkedAt: number } | null = null;
let routeGeneration = 0;
let previousAppState = AppState.currentState;
AppState.addEventListener('change', (state) => {
  if (state === 'active' && previousAppState !== 'active') {
    // VPN reachability and suspended probes cannot survive an app background cycle.
    routeGeneration += 1;
    directRoute = null;
    directProbe = null;
  }
  previousAppState = state;
});
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

// One token per recent stream, fixed fields only: bytes each way, milliseconds
// to Core's first bytes and to the end, which side ended it, the proxy dialect,
// the TLS record types seen each way and Core's first handshake message.
const STREAM_TRACE =
  String.raw`s\d{1,2}=up\d{1,9}\.dn\d{1,9}\.t(?:none|\d{1,7})\.d\d{1,8}` +
  String.raw`\.(?:open|local|remote|reset|stopped)\.p(?:socks|connect)` +
  String.raw`\.o(?:none|\d{1,3}(?:-\d{1,3}){0,5})\.i(?:none|\d{1,3}(?:-\d{1,3}){0,5})\.h(?:none|hrr|\d{1,3})`;
const TUNNEL_SUMMARY = new RegExp(
  String.raw`^local=\d+, opened=\d+, received=\d+, last=[a-z_.]+` +
    String.raw`(?:, sentBytes=\d+, receivedBytes=\d+, deliveredBytes=\d+, localResets=\d+, remoteResets=\d+, ` +
    String.raw`lastReset=(?:none|(?:local|remote)_reset_(?:protocol_error|concurrency_limit|upstream_error|timeout))` +
    String.raw`(?:, streams=${STREAM_TRACE}(?:;${STREAM_TRACE}){0,2})?)?$`,
  'u',
);

async function tunnelDiagnosticSummary(): Promise<string | null> {
  try {
    const native = requireNativeModule<NativeTunnel>('VerityRemoteControlTunnel');
    if (typeof native.diagnosticSummary !== 'function') return null;
    const summary = await native.diagnosticSummary();
    return typeof summary === 'string' && summary.length <= 1024 && TUNNEL_SUMMARY.test(summary)
      ? summary
      : null;
  } catch {
    return null;
  }
}

/** Any HTTP response proves that the pinned direct transport is reachable. */
export function reportDirectRouteSuccess(url: string): void {
  const target = new URL(url);
  if (target.protocol === 'wss:') target.protocol = 'https:';
  const key = keyFor(target.origin);
  if (key !== null) directRoute = { key, reachable: true, checkedAt: Date.now() };
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
  let cancelledPhase: Promise<unknown> | undefined;
  try {
    const response = await Promise.race([
      transport.request(requestId, `${coreUrl}/healthz`, 'GET', {}, null, tlsPin, port),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          cancelledPhase = Promise.resolve()
            .then(() => transport.cancelRequest(requestId))
            .catch(() => undefined);
          reject(new Error('Remote Core probe timed out.'));
        }, timeoutMs);
      }),
    ]);
    if (response.status !== 200) throw new Error('Remote Core probe failed.');
  } catch (error) {
    if (cancelledPhase === undefined) throw error;
    // A stalled native bridge must not turn the bounded probe into another hang.
    let diagnosticTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const phase = await Promise.race([
        cancelledPhase,
        new Promise<undefined>((resolve) => {
          diagnosticTimeout = setTimeout(() => resolve(undefined), 250);
        }),
      ]);
      const knownPhase =
        typeof phase === 'string' &&
        ['NO_AUTH_CHALLENGE', 'AUTH_CHALLENGE_RECEIVED', 'PIN_AND_CHAIN_TRUST_ACCEPTED'].includes(
          phase,
        );
      throw new Error(`Remote Core probe timed out${knownPhase ? ` [TLS:${phase}]` : ''}.`);
    } finally {
      if (diagnosticTimeout !== undefined) clearTimeout(diagnosticTimeout);
    }
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
  const target = new URL(url);
  if (target.protocol === 'wss:') target.protocol = 'https:';
  const key = keyFor(target.origin);
  if (key !== null && directRoute?.key !== key && active === null) {
    // Nothing is known yet (cold start, foreground): send the request directly
    // at once, as the app did before Remote Control existed, and learn the
    // route from its outcome. Waiting for a probe to fail first costs its full
    // timeout on every VPN wake-up, and then an Uplink attempt that can take
    // far longer, before a request that would have worked directly is sent.
    void directRouteReachable(target.origin, key).catch(() => undefined);
    return 0;
  }
  // Admission and explicit diagnostics may take seconds. A healthy direct route
  // must not wait behind their serialized native-tunnel lifecycle operations.
  if (
    key !== null &&
    (await directRouteReachable(target.origin, key)) &&
    keyFor(target.origin) === key &&
    (active === null || active.key === key)
  )
    return 0;
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
  if (
    known !== null &&
    Date.now() - known.checkedAt < (known.reachable ? DIRECT_ROUTE_TTL_MS : DIRECT_FAILURE_TTL_MS)
  )
    return known.reachable;
  const generation = routeGeneration;
  let currentProbe = directProbe?.key === key ? directProbe : null;
  if (currentProbe === null) {
    const promise = probeDirect(coreUrl, key).finally(() => {
      if (directProbe === currentProbe) directProbe = null;
    });
    currentProbe = { key, promise };
    directProbe = currentProbe;
  }
  // While a live tunnel carries traffic, look for the direct route without
  // stalling requests on it; the next request after it answers switches back.
  if (known?.reachable === false && active?.key === key) return false;
  const reachable = await currentProbe.promise;
  if (keyFor(coreUrl) !== key) return false;
  if (routeGeneration !== generation) return directRouteReachable(coreUrl, key);
  return directRoute?.key === key ? directRoute.reachable : reachable;
}

async function probeDirect(coreUrl: string, key: string): Promise<boolean> {
  const previousRoute = directRoute;
  const generation = routeGeneration;
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
  if (routeGeneration === generation && keyFor(coreUrl) === key && directRoute === previousRoute)
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
    // Attachment alone does not prove that the proxied stream reaches the pinned Core.
    await probeCoreThroughEitherProxy(coreUrl, tlsPin, port);
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
      (stage === 'attachment' ? await tunnelStopReason() : null) ?? probeFailureDetail(error);
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
    /^Remote Core probe timed out \[TLS:(NO_AUTH_CHALLENGE|AUTH_CHALLENGE_RECEIVED|PIN_AND_CHAIN_TRUST_ACCEPTED)\]\.$/u.test(
      message,
    )
  )
    return message;
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
  const nativeCause = message.match(
    /Pinned TLS transport failed \[((?:NSURLErrorDomain|kCFErrorDomainCFNetwork|NSOSStatusErrorDomain|NSPOSIXErrorDomain|NSCocoaErrorDomain|kCFErrorDomainSSL|OtherErrorDomain):-?\d{1,20}:(?:NO_AUTH_CHALLENGE|AUTH_CHALLENGE_RECEIVED|PIN_AND_CHAIN_TRUST_ACCEPTED|UNKNOWN_PHASE)(?::streamDomain:-?\d{1,20})?(?::streamCode:-?\d{1,20})?(?::underlying:(?:NSURLErrorDomain|kCFErrorDomainCFNetwork|NSOSStatusErrorDomain|NSPOSIXErrorDomain|NSCocoaErrorDomain|kCFErrorDomainSSL|OtherErrorDomain):-?\d{1,20}(?::streamDomain:-?\d{1,20})?(?::streamCode:-?\d{1,20})?){0,2})\]/u,
  );
  if (nativeCause !== null) return nativeCause[0];
  return message.match(/Pinned TLS verification failed \[[A-Za-z0-9_:.-]{1,150}\]/u)?.[0] ?? null;
}
