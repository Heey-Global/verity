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
  stopWithCause?(cause: string): Promise<void>;
  captureDataDiagnostics?(): Promise<boolean>;
  clearPendingDataDiagnostics?(): Promise<void>;
  recordDataDiagnosticEvent?(event: string): Promise<void>;
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
// The native stall watchdog (RemoteAppTunnel.stallDeadlineSeconds) must have
// ended a dead attachment before the probe gives up on it, or the probe's
// failure reads as an ordinary timeout and backs off instead of attaching
// again. The transport test pins this ordering against the Swift constant.
const PROBE_TIMEOUT_MS = 12_000;
// The watchdog arms on the stream's first sent bytes, the probe timer on the
// request, so the margin between them shrinks by whatever the loopback
// handshake took; after a probe timeout the native stop is given this long
// to land before the failure is classified.
const STALL_STOP_GRACE_MS = 3_000;
// One replacement per window: an attachment that passes its probe and then
// stalls on every read must not be re-admitted every ten seconds. Module
// state like `active`; the transport tests start from a fresh module each.
const STALL_REPLACEMENT_WINDOW_MS = 60_000;
let lastStallReplacement: { key: string; at: number } | null = null;

function stallReplacementAllowed(key: string): boolean {
  return (
    lastStallReplacement?.key !== key ||
    Date.now() - lastStallReplacement.at >= STALL_REPLACEMENT_WINDOW_MS
  );
}
// Native keeps its own copy; a JavaScript reload must not leave the two apart.
let proxyModeSynced = false;

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
  if (typeof transport.setProxyMode === 'function' && !proxyModeSynced) {
    await transport.setProxyMode(proxyMode);
    proxyModeSynced = true;
  }
  try {
    await dataDiagnosticEvent('probe_started');
    await probeCore(coreUrl, tlsPin, port);
    await dataDiagnosticEvent('probe_succeeded');
  } catch (error) {
    await dataDiagnosticEvent('probe_failed');
    // Only a handshake the client abandoned after Core had answered points at
    // the proxy path. A rejected pin, an HTTP failure or a Core that never
    // replied through the tunnel would cost a second full probe for nothing.
    if (
      typeof transport.setProxyMode !== 'function' ||
      !(error instanceof Error && error.message.includes('NO_AUTH_CHALLENGE')) ||
      !(await tunnelReceivedBytes())
    )
      throw error;
    const other: ProxyMode = proxyMode === 'socks' ? 'connect' : 'socks';
    try {
      await transport.setProxyMode(other);
    } catch {
      throw error;
    }
    try {
      await dataDiagnosticEvent('probe_started');
      await probeCore(coreUrl, tlsPin, port);
      await dataDiagnosticEvent('probe_succeeded');
    } catch (otherError) {
      await dataDiagnosticEvent('probe_failed');
      await transport.setProxyMode(proxyMode).catch(() => {
        // Native may still be on the trial dialect; sync again before the next probe.
        proxyModeSynced = false;
      });
      throw new ProbeFallbackFailure(error, otherError, other);
    }
    proxyMode = other;
    console.info('Remote Control proxy dialect switched', { proxyMode });
  }
}

// Only "no such host", "cannot connect" and a refused certificate condemn the
// address; a timeout, a lost connection or "offline" is what a VPN still
// coming up looks like, and a read in flight then keeps its grace period.
function definiteRefusal(reason: string | null): DirectVerdict {
  if (reason === null) return 'unknown';
  if (reason.startsWith('Pinned TLS verification failed')) return 'dead';
  return /^Pinned TLS transport failed \[NSURLErrorDomain:-100[34]:/u.test(reason) ||
    /:NSPOSIXErrorDomain:61(?::|\])/u.test(reason)
    ? 'dead'
    : 'unknown';
}

// Whether the probe's own stream, or failing that the attachment, ever
// carried a reply from Core. The counters belong to this attachment alone.
async function tunnelReceivedBytes(): Promise<boolean> {
  const summary = await tunnelDiagnosticSummary();
  if (summary === null) return false;
  const streams = summary.match(/, streams=(.*)$/u)?.[1];
  if (streams !== undefined)
    return [...streams.matchAll(/\.dn(\d+)\./gu)].some((match) => Number(match[1]) > 0);
  const received = summary.match(/, receivedBytes=(\d+)/u)?.[1];
  return received !== undefined && Number(received) > 0;
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
let directRefusal: { key: string; reason: string } | null = null;
let routeGeneration = 0;
let diagnosticCaptureUntil = 0;
let previousAppState = AppState.currentState;
AppState.addEventListener('change', (state) => {
  if (state === 'active' && previousAppState !== 'active') {
    // VPN reachability and suspended probes cannot survive an app background cycle.
    routeGeneration += 1;
    directRoute = null;
    directProbe = null;
  }
  if (state === 'active' || state === 'background' || state === 'inactive') {
    void dataDiagnosticEvent(`app_${state}`);
  }
  previousAppState = state;
});
// 'dead' is a definite refusal (no host, connection refused); 'unknown' is a
// probe timeout, which says little about an address a VPN is still waking up for.
export type DirectVerdict = 'reachable' | 'dead' | 'unknown';
let directProbe: {
  key: string;
  promise: Promise<boolean>;
  verdict: Promise<DirectVerdict>;
} | null = null;
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

// Null when the native module threw: nothing can be recovered through it,
// and a stop reason read from it would not be this attachment's.
async function isTunnelStopped(): Promise<boolean | null> {
  try {
    return !(await requireNativeModule<NativeTunnel>('VerityRemoteControlTunnel').isActive());
  } catch {
    return null;
  }
}

// Bounded as a whole, each native call included: this runs inside the
// serialized tunnel operation, and a native call that hangs would otherwise
// hold every queued read and route selection behind it.
async function tunnelStoppedWithin(graceMs: number): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([
      isTunnelStopped(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), remaining);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    if (stopped === null) return false;
    if (stopped === true) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, remaining)));
  }
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
// The `k` key and the `fo`/`fi` frame counts are absent from native builds
// that predate Core's stream records; a summary without them must still parse.
const STREAM_TRACE =
  String.raw`s\d{1,2}=(?:k[0-9A-Fa-f]{8}\.)?up\d{1,9}\.dn\d{1,9}(?:\.fo\d{1,7}\.fi\d{1,7})?\.t(?:none|\d{1,7})\.d\d{1,8}` +
  String.raw`\.(?:open|local|remote|reset|stopped)\.p(?:socks|connect)` +
  String.raw`\.o(?:none|\d{1,3}(?:-\d{1,3}){0,7})\.i(?:none|\d{1,3}(?:-\d{1,3}){0,7})\.h(?:none|hrr|\d{1,3})`;
const TUNNEL_SUMMARY = new RegExp(
  String.raw`^(local=\d+, opened=\d+, received=\d+, last=[a-z_.]+` +
    String.raw`(?:, sentBytes=\d+, receivedBytes=\d+, deliveredBytes=\d+, localResets=\d+, remoteResets=\d+, ` +
    String.raw`lastReset=(?:none|(?:local|remote)_reset_(?:protocol_error|concurrency_limit|upstream_error|timeout))` +
    // Attachment age and heartbeat liveness; absent from older native builds.
    String.raw`(?:, age=(?:none|\d{1,8}), pings=\d{1,6}/\d{1,6}, pongAge=(?:none|\d{1,8}))?)?)` +
    String.raw`(?:, streams=([^\n]*))?$`,
  'u',
);
const STREAM_TRACES = new RegExp(String.raw`^${STREAM_TRACE}(?:;${STREAM_TRACE}){0,2}$`, 'u');

// The counters stay visible even when one stream token is out of shape.
function acceptedSummary(summary: unknown): string | null {
  if (typeof summary !== 'string' || summary.length > 1024) return null;
  const match = TUNNEL_SUMMARY.exec(summary);
  if (match === null) return null;
  const [, base, traces] = match;
  if (base === undefined) return null;
  return traces !== undefined && STREAM_TRACES.test(traces) ? `${base}, streams=${traces}` : base;
}

async function tunnelDiagnosticSummary(): Promise<string | null> {
  try {
    const native = requireNativeModule<NativeTunnel>('VerityRemoteControlTunnel');
    if (typeof native.diagnosticSummary !== 'function') return null;
    return acceptedSummary(await native.diagnosticSummary());
  } catch {
    return null;
  }
}

/**
 * The route probe still running for this Core, if any. A direct read sent
 * while nothing was known can give up on its verdict instead of sitting in
 * its own request timeout.
 */
export function pendingDirectVerdict(url: string): Promise<DirectVerdict> | null {
  const target = new URL(url);
  if (target.protocol === 'wss:') target.protocol = 'https:';
  const key = keyFor(target.origin);
  return key !== null && directProbe?.key === key ? directProbe.verdict : null;
}

/** The probe's own refusal, for a read that was cancelled on its verdict. */
export function lastDirectRefusal(url: string): string | null {
  const target = new URL(url);
  if (target.protocol === 'wss:') target.protocol = 'https:';
  const key = keyFor(target.origin);
  return key !== null && directRefusal?.key === key ? directRefusal.reason : null;
}

/** A newer direct response supersedes a pending probe's cancellation decision. */
export function directRouteKnownReachable(url: string): boolean {
  const target = new URL(url);
  if (target.protocol === 'wss:') target.protocol = 'https:';
  const key = keyFor(target.origin);
  return key !== null && directRoute?.key === key && directRoute.reachable;
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

async function stopNativeTunnel(
  cause: 'profile_changed' | 'probe_failure' | 'replacement',
): Promise<void> {
  const native = requireNativeModule<NativeTunnel>('VerityRemoteControlTunnel');
  if (typeof native.stopWithCause === 'function') await native.stopWithCause(cause);
  else await native.stop();
}

async function dataDiagnosticEvent(
  event:
    | 'probe_started'
    | 'probe_succeeded'
    | 'probe_failed'
    | 'app_active'
    | 'app_background'
    | 'app_inactive',
): Promise<void> {
  if (Date.now() >= diagnosticCaptureUntil) return;
  try {
    const native = requireNativeModule<NativeTunnel>('VerityRemoteControlTunnel');
    await native.recordDataDiagnosticEvent?.(event);
  } catch {
    /* Diagnostic availability does not decide transport success. */
  }
}

async function probeCore(
  coreUrl: string,
  tlsPin: string,
  port: number,
  timeoutMs = PROBE_TIMEOUT_MS,
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
      const safePhase =
        typeof phase === 'string'
          ? /^(NO_AUTH_CHALLENGE|AUTH_CHALLENGE_RECEIVED|PIN_AND_CHAIN_TRUST_ACCEPTED)(?:;(tx\d{1,2},proxy[01],connect[01],tls[01],response[01]))?$/u.exec(
              phase,
            )
          : null;
      throw new Error(
        `Remote Core probe timed out${safePhase ? ` [TLS:${safePhase[1]}${safePhase[2] ? `; ${safePhase[2]}` : ''}]` : ''}.`,
      );
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

/** A disabled descriptor removes Remote Control from selectable routes. */
export async function remoteControlAvailableForUrl(url: string): Promise<boolean> {
  const target = new URL(url);
  if (target.protocol === 'wss:') target.protocol = 'https:';
  if (keyFor(target.origin) !== null) return true;
  const cleanup = operation.then(async () => {
    if (active === null || keyFor(target.origin) !== null) return;
    active = null;
    try {
      await requireNativeModule<NativeTunnel>('VerityRemoteControlTunnel').stop();
    } catch {
      // Direct Core requests remain usable if native cleanup fails.
    }
  });
  operation = cleanup;
  await cleanup;
  return false;
}

/**
 * Return zero for a direct pinned connection. Admission failure never replays an
 * API request. `replayable` says the caller can repeat the request through
 * Uplink if the direct route loses it; a mutation cannot, and waits for the
 * route verdict instead.
 */
export async function remoteControlPortForUrl(url: string, replayable = false): Promise<number> {
  const target = new URL(url);
  if (target.protocol === 'wss:') target.protocol = 'https:';
  const key = keyFor(target.origin);
  if (key !== null && directRoute?.key !== key && active === null) {
    // Nothing is known yet (cold start, foreground): send a replayable request
    // directly at once, as the app did before Remote Control existed, and learn
    // the route from its outcome. Waiting for a probe to fail first costs its
    // full timeout on every VPN wake-up, and then an Uplink attempt that can
    // take far longer, before a request that would have worked directly is sent.
    const probe = directRouteReachable(target.origin, key).catch(() => false);
    if (replayable) return 0;
    await probe;
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
  capture = false,
): Promise<{ ready: boolean; detail: string }> {
  const selected = operation.then(async () => {
    const target = new URL(url).origin;
    const key = keyFor(target);
    if (key === null) {
      return { ready: false, detail: remoteControlFailureForUrl(target) ?? 'route unavailable' };
    }
    const native = requireNativeModule<NativeTunnel>('VerityRemoteControlTunnel');
    if (capture) {
      if (typeof native.captureDataDiagnostics !== 'function') {
        return { ready: false, detail: 'update the app to record connection diagnostics' };
      }
      // Arm on a fresh socket: recording an active tunnel misses its first sends.
      await stopNativeTunnel('replacement');
      active = null;
      if (!(await native.captureDataDiagnostics())) {
        return {
          ready: false,
          detail: 'the recording window ended; reconnect before recording another test',
        };
      }
      diagnosticCaptureUntil = Date.now() + 120_000;
    }
    try {
      const attachment = active;
      if (attachment?.key === key) {
        try {
          if (await requireNativeModule<NativeTunnel>('VerityRemoteControlTunnel').isActive()) {
            const pin = getServerProfile()?.endpoints.find((entry) => entry.url === target)?.tlsPin;
            if (pin !== undefined) {
              await probeCoreThroughEitherProxy(target, pin, attachment.port);
              return { ready: true, detail: 'Core health check passed through Uplink' };
            }
          }
        } catch (error) {
          // A diagnostic must not replace a tunnel that may be carrying transfers.
          const summary = await tunnelDiagnosticSummary();
          return {
            ready: false,
            detail: `probe (${probeFailureDetail(error) ?? 'Core did not answer'}${summary ? `; tunnel ${summary}` : ''})`,
          };
        }
      }
      const port = await open(target, key);
      return port > 0
        ? { ready: true, detail: 'Core health check passed through Uplink' }
        : { ready: false, detail: remoteControlFailureForUrl(target) ?? 'connection failed' };
    } finally {
      if (capture) await native.clearPendingDataDiagnostics?.().catch(() => undefined);
    }
  });
  operation = selected.then(
    () => undefined,
    () => undefined,
  );
  return selected;
}

/**
 * A read failed on the tunnel. Returns the port to retry it on: the same
 * port when the attachment still answers Core, a fresh attachment's port
 * when the native stall watchdog has ended it, zero when nothing can be
 * recovered. A dead attachment is replaced here rather than after the
 * 15 s back-off, since a fresh one has answered every time so far.
 */
export async function recoverRemoteControlRead(url: string, port: number): Promise<number> {
  const selected = operation.then(async () => {
    const target = new URL(url).origin;
    const key = keyFor(target);
    if (key === null || active?.key !== key) return 0;
    // Every read in flight fails at the same moment when the watchdog ends an
    // attachment; the first one here replaces it, the rest retry on the
    // replacement instead of each reporting a failure. The same holds for any
    // superseded attachment: whatever is active now was probed when it opened.
    const pin = getServerProfile()?.endpoints.find((entry) => entry.url === target)?.tlsPin;
    if (pin === undefined) return 0;
    try {
      const native = requireNativeModule<NativeTunnel>('VerityRemoteControlTunnel');
      if (active.port !== port) return (await native.isActive()) ? active.port : 0;
      if (!(await native.isActive())) {
        const reason = await tunnelStopReason();
        console.warn(`Remote Control tunnel ended: ${reason ?? 'no reason reported'}`);
        // `active` is only the key and port; the admission was finished when
        // the attachment opened, and the native tunnel has stopped itself.
        active = null;
        // Only a stall is replaced here, for this read, and only once per
        // window. Any other end is left to the next request's route
        // selection, which clears `active` the same way when it finds the
        // tunnel stopped.
        if (reason?.startsWith('stall') !== true || keyFor(target) !== key) return 0;
        if (!stallReplacementAllowed(key)) {
          lastFailure = { key, stage: 'probe', detail: 'stall: replaced once already this minute' };
          retryAfter = Date.now() + 15_000;
          return 0;
        }
        lastStallReplacement = { key, at: Date.now() };
        // Deliberately not route selection: the read is already on Uplink and
        // the direct route was found wanting when it was sent; the window
        // above bounds the re-admissions. `open` records the replacement as
        // the active attachment, so the reads queued behind this one find it.
        const replacement = await open(target, key, { retryStall: false });
        // Logged so a watchdog that fires on a merely slow link can be told
        // from one that caught a dead attachment, and its deadline tuned.
        console.info('Remote Control stall replacement', { replaced: replacement > 0 });
        return replacement;
      }
      await probeCoreThroughEitherProxy(target, pin, port);
      return active?.key === key && active.port === port ? port : 0;
    } catch {
      return 0;
    }
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
        await stopNativeTunnel('profile_changed');
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
        await stopNativeTunnel('profile_changed');
      } catch {
        // A missing native module leaves the direct route usable.
      }
    }
    return 0;
  }
  if (active !== null && active.key !== key) {
    active = null;
    try {
      await stopNativeTunnel('profile_changed');
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
      await stopNativeTunnel('profile_changed');
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
    const outcome = probeDirect(coreUrl, key).finally(() => {
      if (directProbe === currentProbe) directProbe = null;
    });
    currentProbe = {
      key,
      promise: outcome.then((result) => result.reachable),
      verdict: outcome.then(
        (result) => result.verdict,
        (): DirectVerdict => 'unknown',
      ),
    };
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

async function probeDirect(
  coreUrl: string,
  key: string,
): Promise<{ reachable: boolean; verdict: DirectVerdict }> {
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
  const verdict = reachable ? 'reachable' : definiteRefusal(reason);
  if (verdict === 'dead' && reason !== null) directRefusal = { key, reason };
  return { reachable, verdict };
}

async function open(
  coreUrl: string,
  key: string,
  options: { retryStall: boolean } = { retryStall: true },
): Promise<number> {
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
      await stopNativeTunnel('profile_changed');
      return 0;
    }
    // Attachment alone does not prove that the proxied stream reaches the pinned Core.
    await probeCoreThroughEitherProxy(coreUrl, tlsPin, port);
    if (keyFor(coreUrl) !== key) {
      await stopNativeTunnel('profile_changed');
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
    // The watchdog's stop tears the loopback sockets down, so the probe in
    // flight ends with a transport error when the stop lands first and with a
    // timeout when the probe gives up first; only the latter is worth waiting
    // on, since any reply bytes disarm the watchdog. At this stage the native
    // module holds this attachment (its start succeeded), so once it reports
    // stopped the reason is this attachment's own; while it is live the
    // reason may still be the previous attachment's and is not read.
    const stalled =
      stage === 'probe' &&
      ((await isTunnelStopped()) === true ||
        (error instanceof Error &&
          error.message.startsWith('Remote Core probe timed out') &&
          (await tunnelStoppedWithin(STALL_STOP_GRACE_MS)))) &&
      (await tunnelStopReason())?.startsWith('stall') === true;
    if (tunnelStarted) {
      try {
        await stopNativeTunnel('probe_failure');
      } catch {
        // A failed probe still falls back to the direct pinned connection.
      }
    }
    // An attachment that went dead under its first probe is replaced once at
    // once; a fresh one has answered every time so far. Anything else backs off.
    if (stalled && options.retryStall && keyFor(coreUrl) === key && stallReplacementAllowed(key)) {
      lastStallReplacement = { key, at: Date.now() };
      console.warn('Remote Control attachment stalled during its probe; attaching again');
      return open(coreUrl, key, { retryStall: false });
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
    /^Remote Core probe timed out \[TLS:(NO_AUTH_CHALLENGE|AUTH_CHALLENGE_RECEIVED|PIN_AND_CHAIN_TRUST_ACCEPTED)(?:; tx\d{1,2},proxy[01],connect[01],tls[01],response[01])?\]\.$/u.test(
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
