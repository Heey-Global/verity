import { type TransportRequestInit, markSwitchTransportRequest } from '@verity/mobile';
import { requireNativeModule } from 'expo-modules-core';
import {
  directRouteKnownReachable,
  lastDirectRefusal,
  pendingDirectVerdict,
  recoverRemoteControlRead,
  remoteControlAvailableForUrl,
  remoteControlFailureForUrl,
  remoteControlPortForUrl,
  reportDirectRouteFailure,
  reportDirectRouteSuccess,
} from './remoteControlTransport';

type NativeResponse = {
  status: number;
  headers: Record<string, string>;
} & ({ bodyBase64: string; bodyText?: never } | { bodyText: string; bodyBase64?: never });

interface NativePinnedTransport {
  supportsTransportLanes?: () => boolean;
  exportTransportTimings?: () => { records: unknown[]; omitted: number };
  request(
    requestId: string,
    url: string,
    method: string,
    headers: Record<string, string>,
    bodyBase64: string | null,
    tlsPin: string,
    proxyPort: number,
  ): Promise<NativeResponse>;
  /** New native builds decode textual bodies without a Base64 bridge round-trip. */
  requestV2?: NativePinnedTransport['request'];
  download(
    url: string,
    headers: Record<string, string>,
    destination: string,
    tlsPin: string,
    proxyPort: number,
  ): Promise<{ status: number; uri: string }>;
  upload(
    requestId: string,
    url: string,
    method: string,
    headers: Record<string, string>,
    source: string,
    tlsPin: string,
    proxyPort: number,
  ): Promise<NativeResponse>;
  cancelRequest(requestId: string): Promise<void>;
  verifyIdentity(
    identityKey: string,
    serverId: string,
    challenge: string,
    signature: string,
  ): Promise<boolean>;
  openWebSocket(
    url: string,
    tlsPin: string,
    protocols: string[],
    proxyPort: number,
  ): Promise<string>;
  closeWebSocket(id: string): Promise<void>;
  sendWebSocket(id: string, text: string): Promise<void>;
  addListener(
    event: 'onWebSocketEvent',
    listener: (event: {
      id: string;
      type: 'open' | 'message' | 'error' | 'close';
      data?: string;
      code?: number;
    }) => void,
  ): { remove(): void };
}

type BackgroundQueue = { active: number; waiting: Array<() => void> };
const backgroundQueues = new Map<string, BackgroundQueue>();

/** Bound slow direct reads across clients and downloads sharing a native host pool. */
function admitBackground(url: string, signal?: AbortSignal | null): Promise<() => void> {
  if (signal?.aborted)
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  const host = new URL(url).host.toLowerCase();
  let queue = backgroundQueues.get(host);
  if (!queue) {
    queue = { active: 0, waiting: [] };
    backgroundQueues.set(host, queue);
  }
  const current = queue;
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      const index = current.waiting.indexOf(admit);
      if (index >= 0) current.waiting.splice(index, 1);
      if (!current.active && !current.waiting.length) backgroundQueues.delete(host);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    const admit = (): void => {
      signal?.removeEventListener('abort', abort);
      current.active += 1;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        current.active -= 1;
        current.waiting.shift()?.();
        if (!current.active && !current.waiting.length) backgroundQueues.delete(host);
      });
    };
    if (current.active < 2) admit();
    else {
      current.waiting.push(admit);
      signal?.addEventListener('abort', abort, { once: true });
    }
  });
}

export async function downloadPinnedFile(input: {
  url: string;
  headers?: Record<string, string>;
  destination: string;
  tlsPin: string;
  useRemote?: boolean;
  /** Cancels routing/admission before dispatch; the legacy native download is not cancellable. */
  signal?: AbortSignal;
}): Promise<string> {
  if (input.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  const port =
    input.useRemote && (await remoteControlAvailableForUrl(input.url))
      ? await remoteControlPortForUrl(input.url)
      : 0;
  const release = port === 0 ? await admitBackground(input.url, input.signal) : undefined;
  try {
    if (input.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const response = await native().download(
      input.url,
      input.headers ?? {},
      input.destination,
      input.tlsPin,
      port,
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`File download failed with status ${String(response.status)}.`);
    }
    return response.uri;
  } finally {
    release?.();
  }
}

let nativeModule: NativePinnedTransport | null | undefined;

function native(): NativePinnedTransport {
  try {
    nativeModule ??= requireNativeModule<NativePinnedTransport>('VerityPinnedTransport');
  } catch {
    throw new Error('Pinned Verity transport is not available on this platform.');
  }
  return nativeModule;
}

async function requestNative(
  transport: NativePinnedTransport,
  ...args: Parameters<NativePinnedTransport['request']>
): Promise<NativeResponse> {
  // OTA JavaScript also runs on older native builds. Select by capability once
  // per request; a failed V2 mutation must never be replayed through the old API.
  const diagnosticRequestId = args[3]['x-verity-switch-request'];
  markSwitchTransportRequest(diagnosticRequestId, 'native-dispatch', args[6] > 0 ? 1 : 0);
  try {
    const response = await (transport.requestV2
      ? transport.requestV2(...args)
      : transport.request(...args));
    markSwitchTransportRequest(diagnosticRequestId, 'native-return', Date.now());
    return response;
  } catch (error) {
    markSwitchTransportRequest(diagnosticRequestId, 'native-error');
    throw error;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBuffer(encoded: string): ArrayBuffer {
  const binary = atob(encoded);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return buffer;
}

function utf8ResponseBody(response: NativeResponse): BodyInit | null {
  if ([204, 205, 304].includes(response.status)) return null;
  if (response.bodyText !== undefined) {
    // Match TextDecoder's default BOM handling, including retaining a second BOM.
    return response.bodyText.startsWith('\uFEFF') ? response.bodyText.slice(1) : response.bodyText;
  }
  const buffer = base64ToBuffer(response.bodyBase64);
  const contentType = Object.entries(response.headers).find(
    ([name]) => name.toLowerCase() === 'content-type',
  )?.[1];
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (
    mediaType?.startsWith('text/') ||
    mediaType === 'application/json' ||
    mediaType?.endsWith('+json')
  ) {
    // React Native's whatwg-fetch Response decodes an ArrayBuffer by mapping each
    // byte directly to a JS character. Decode textual native responses here, at
    // the byte boundary, so UTF-8 never reaches that Latin-1-shaped fallback.
    return new TextDecoder('utf-8').decode(buffer);
  }
  return buffer;
}

async function encodeBody(body: BodyInit | null | undefined): Promise<string | null> {
  if (body == null) return null;
  if (typeof body === 'string') return bytesToBase64(new TextEncoder().encode(body));
  if (body instanceof Blob) return bytesToBase64(new Uint8Array(await body.arrayBuffer()));
  if (body instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(body));
  if (ArrayBuffer.isView(body))
    return bytesToBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  if (body instanceof URLSearchParams)
    return bytesToBase64(new TextEncoder().encode(body.toString()));
  throw new Error('This request body is not supported by the pinned transport.');
}

// How long a direct read may keep waiting after the 3 s route probe timed out.
// The probe cannot tell a VPN still waking up from a blackholed address, so
// off the VPN a blackholed cold start now costs about 7 s before Uplink is
// tried, where it used to cost 3 s; on the VPN, which is where the app is
// used most, the same 7 s let a slow wake-up succeed directly.
const DIRECT_GRACE_MS = 4_000;

export function createPinnedFetch(tlsPin: string, useRemote = false): typeof fetch {
  return (async (input: RequestInfo | URL, init: TransportRequestInit = {}) => {
    if (input instanceof Request)
      throw new Error('Request objects are not supported by the pinned transport.');
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const diagnosticRequestId = headers['x-verity-switch-request'];
    markSwitchTransportRequest(diagnosticRequestId, 'pinned-entry');
    const remoteEnabled = useRemote && (await remoteControlAvailableForUrl(url));
    markSwitchTransportRequest(diagnosticRequestId, 'remote-availability-ready');
    // Older native bridges forward every header, so only send lane metadata to
    // builds that strip it before creating the network request.
    if (native().supportsTransportLanes?.()) {
      headers['x-verity-transport-lane'] = init.transportLane ?? 'background';
    }
    const fileUri =
      typeof init.body === 'object' &&
      init.body !== null &&
      'uri' in init.body &&
      typeof init.body.uri === 'string' &&
      init.body.uri.startsWith('file:')
        ? init.body.uri
        : null;
    if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const transport = native();
    const onAbort = (): void => {
      void transport.cancelRequest(requestId);
    };
    init.signal?.addEventListener('abort', onAbort, { once: true });
    let response!: NativeResponse;
    let releaseLane: (() => void) | undefined;
    const background =
      (init.method ?? 'GET').toUpperCase() === 'GET' && init.transportLane !== 'interactive';
    const admitDirect = async (): Promise<void> => {
      if (background && !releaseLane) releaseLane = await admitBackground(url, init.signal);
    };
    try {
      const encodedBody = fileUri ? null : await encodeBody(init.body);
      markSwitchTransportRequest(diagnosticRequestId, 'body-encoded');
      const replayable =
        !fileUri && (init.method ?? 'GET').toUpperCase() === 'GET' && encodedBody === null;
      let port = remoteEnabled
        ? await remoteControlPortForUrl(url, replayable, diagnosticRequestId)
        : 0;
      markSwitchTransportRequest(diagnosticRequestId, 'route-ready', port > 0 ? 1 : 0);
      if (init.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      // Admission can outlast the route probe and its pending registry entry.
      // Keep that verdict so a queued cold read retains cancellation and recovery.
      let verdict = remoteEnabled && replayable && port === 0 ? pendingDirectVerdict(url) : null;
      let queuedVerdict: string | undefined;
      void verdict?.then(
        (outcome) => {
          queuedVerdict = outcome;
        },
        () => undefined,
      );
      if (port === 0) await admitDirect();
      if (queuedVerdict === 'dead' && !directRouteKnownReachable(url)) {
        port = await remoteControlPortForUrl(url, true);
        if (port > 0) {
          verdict = null;
          releaseLane?.();
          releaseLane = undefined;
        }
      }
      if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      markSwitchTransportRequest(diagnosticRequestId, 'lane-admitted');
      // A read sent directly while the route is unknown must not sit in a
      // request timeout: a definite refusal from the capped probe cancels it
      // at once, and a probe timeout grants it a few more seconds, which a
      // waking VPN needs and a blackholed address does not deserve.
      let settled = false;
      let cancelledBy: 'verdict' | 'grace' | null = null;
      let grace: ReturnType<typeof setTimeout> | undefined;

      if (verdict !== null) {
        void verdict.then(
          (outcome) => {
            if (settled || outcome === 'reachable' || directRouteKnownReachable(url)) return;
            if (outcome === 'dead') {
              cancelledBy = 'verdict';
              void transport.cancelRequest(requestId);
            } else
              grace = setTimeout(() => {
                if (settled || directRouteKnownReachable(url)) return;
                cancelledBy = 'grace';
                void transport.cancelRequest(requestId);
              }, DIRECT_GRACE_MS);
          },
          () => undefined,
        );
      }
      let recovered = false;
      try {
        // A completed refusal must not cancel an ID before native installs it.
        if (port === 0 && queuedVerdict === 'dead' && !directRouteKnownReachable(url)) {
          cancelledBy = 'verdict';
          throw new Error('Direct route probe reported an unavailable paired address.');
        }
        response = fileUri
          ? await transport.upload(
              requestId,
              url,
              init.method ?? 'POST',
              headers,
              fileUri,
              tlsPin,
              port,
            )
          : await requestNative(
              transport,
              requestId,
              url,
              init.method ?? 'GET',
              headers,
              encodedBody,
              tlsPin,
              port,
            );
        settled = true;
        if (remoteEnabled && port === 0 && !init.signal?.aborted) reportDirectRouteSuccess(url);
      } catch (error) {
        settled = true;
        let directFailed = port === 0;
        let failure: Error = error instanceof Error ? error : new Error('native transport error');
        // The port to retry on may be a fresh attachment's when the old one stalled.
        const retryPort =
          port > 0 &&
          replayable &&
          failure.message.includes('NO_AUTH_CHALLENGE') &&
          !init.signal?.aborted
            ? await recoverRemoteControlRead(url, port)
            : 0;
        if (retryPort > 0) {
          if (init.signal?.aborted)
            throw new DOMException('The operation was aborted.', 'AbortError');
          try {
            response = await requestNative(
              transport,
              requestId,
              url,
              'GET',
              headers,
              null,
              tlsPin,
              retryPort,
            );
            if (init.signal?.aborted) {
              throw new DOMException('The operation was aborted.', 'AbortError');
            }
            recovered = true;
          } catch (retryError) {
            if (init.signal?.aborted) {
              throw new DOMException('The operation was aborted.', 'AbortError');
            }
            failure = retryError instanceof Error ? retryError : failure;
          }
        }
        if (
          !recovered &&
          port > 0 &&
          !fileUri &&
          (init.method ?? 'GET').toUpperCase() === 'GET' &&
          encodedBody === null &&
          !init.signal?.aborted
        ) {
          try {
            await admitDirect();
            if (init.signal?.aborted) {
              throw new DOMException('The operation was aborted.', 'AbortError');
            }
            // A failed read has no uncertain mutation to replay. Keep the same
            // paired URL and pin when a reachable direct route can recover it.
            response = await requestNative(
              transport,
              requestId,
              url,
              'GET',
              headers,
              null,
              tlsPin,
              0,
            );
            if (init.signal?.aborted) {
              throw new DOMException('The operation was aborted.', 'AbortError');
            }
            // A recovered direct read must also move subsequent requests off the failed tunnel.
            reportDirectRouteSuccess(url);
            recovered = true;
          } catch (directError) {
            if (init.signal?.aborted) throw directError;
            failure = directError instanceof Error ? directError : failure;
            directFailed = true;
          }
        }
        if (remoteEnabled && directFailed && !init.signal?.aborted) reportDirectRouteFailure(url);
        let remoteAttempted = false;
        let remoteReason: string | null = null;
        if (
          !recovered &&
          verdict !== null &&
          port === 0 &&
          remoteEnabled &&
          directFailed &&
          replayable &&
          !init.signal?.aborted
        ) {
          // The direct route was tried first without knowing whether it works.
          // A read that it lost is recovered through Uplink, which the failure
          // just made the route for the requests that follow.
          let remotePort = 0;
          try {
            remotePort = await remoteControlPortForUrl(url, true);
          } catch {
            // Route selection reports its own admission and probe failures;
            // this is the native bridge itself failing.
            console.warn('Remote Control route selection threw while recovering a direct read');
          }
          if (init.signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
          }
          if (remotePort > 0) {
            releaseLane?.();
            releaseLane = undefined;
            remoteAttempted = true;
            try {
              response = await requestNative(
                transport,
                requestId,
                url,
                'GET',
                headers,
                null,
                tlsPin,
                remotePort,
              );
              if (init.signal?.aborted) {
                throw new DOMException('The operation was aborted.', 'AbortError');
              }
              recovered = true;
            } catch (remoteError) {
              if (init.signal?.aborted) {
                throw new DOMException('The operation was aborted.', 'AbortError');
              }
              // Both legs are named below: a pin rejected on the Uplink leg
              // must not hide behind the direct failure.
              remoteReason = safeTransportReason(remoteError);
            }
          }
        }
        if (!recovered) {
          const skipped = port === 0 && remoteEnabled ? remoteControlFailureForUrl(url) : null;
          const route =
            port > 0
              ? replayable
                ? 'Uplink and direct Core requests'
                : 'Uplink Core request'
              : remoteAttempted
                ? 'Direct and Uplink Core requests'
                : skipped === null
                  ? 'Direct Core request'
                  : `Uplink ${skipped} and direct Core request`;
          // A read the app cancelled itself reports why, not its own -999.
          const reason =
            cancelledBy === 'verdict'
              ? (lastDirectRefusal(url) ?? safeTransportReason(failure))
              : cancelledBy === 'grace'
                ? 'paired address unanswered after the route probe timed out'
                : safeTransportReason(failure);
          const diagnostic = new Error(
            `${route} failed: ${reason}${remoteReason === null ? '' : `; Uplink: ${remoteReason}`}`,
          );
          diagnostic.name = 'VerityConnectionError';
          throw diagnostic;
        }
      } finally {
        if (grace !== undefined) clearTimeout(grace);
      }
    } catch (error) {
      if (init.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      throw error;
    } finally {
      releaseLane?.();
      init.signal?.removeEventListener('abort', onAbort);
    }
    const body = utf8ResponseBody(response);
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  }) as typeof fetch;
}

// Only the bounded native phase and code list may reach the screen.
function safeTransportReason(error: unknown): string {
  return error instanceof Error
    ? (error.message.match(/Pinned TLS (?:transport|verification) failed \[[^\]]{1,150}\]/u)?.[0] ??
        'native transport error')
    : 'native transport error';
}

export async function verifyPairedIdentity(input: {
  identityKey: string;
  expectedServerId: string;
  serverId: string;
  challenge: string;
  signature: string;
}): Promise<void> {
  if (input.serverId !== input.expectedServerId)
    throw new Error('The server identity does not match the pairing code.');
  if (
    !(await native().verifyIdentity(
      input.identityKey,
      input.serverId,
      input.challenge,
      input.signature,
    ))
  ) {
    throw new Error('The server identity signature is invalid.');
  }
}

type SocketListener = (event: { data: unknown; code?: number }) => void;

export function createPinnedWebSocket(
  url: string,
  tlsPin: string,
  protocols: string | string[] = [],
  useRemote = false,
) {
  const listeners = new Map<'open' | 'message' | 'close' | 'error', Set<SocketListener>>();
  let socketId: string | null = null;
  let closed = false;
  const subscription = native().addListener('onWebSocketEvent', (event) => {
    if (event.id !== socketId) return;
    if (
      event.type === 'open' ||
      event.type === 'message' ||
      event.type === 'close' ||
      event.type === 'error'
    ) {
      for (const listener of listeners.get(event.type) ?? [])
        listener({ data: event.data, ...(event.code !== undefined ? { code: event.code } : {}) });
    }
    if (event.type === 'close') subscription.remove();
  });
  void (async () => {
    const port =
      useRemote && (await remoteControlAvailableForUrl(url))
        ? await remoteControlPortForUrl(url)
        : 0;
    return native().openWebSocket(
      url,
      tlsPin,
      typeof protocols === 'string' ? [protocols] : protocols,
      port,
    );
  })()
    .then((id) => {
      socketId = id;
      if (closed) void native().closeWebSocket(id);
    })
    .catch((error: unknown) => {
      for (const listener of listeners.get('error') ?? []) listener({ data: error });
      for (const listener of listeners.get('close') ?? []) listener({ data: error });
      subscription.remove();
    });
  return {
    addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: SocketListener) {
      const registered = listeners.get(type) ?? new Set<SocketListener>();
      registered.add(listener);
      listeners.set(type, registered);
    },
    send(data: string) {
      // The live connection sends only after the server's `ready`, so the native
      // socket exists by then; anything earlier would have nowhere to go.
      if (closed || socketId === null) return;
      void native()
        .sendWebSocket(socketId, data)
        .catch(() => undefined);
    },
    close() {
      closed = true;
      if (socketId !== null) void native().closeWebSocket(socketId);
      subscription.remove();
    },
  };
}

/** Optional native capability: older installed builds remain usable and report the gap. */
export function exportPinnedTransportTimings(): {
  available: boolean;
  records: Record<string, unknown>[];
  omitted: number;
} {
  try {
    const transport = native();
    if (!transport.exportTransportTimings) return { available: false, records: [], omitted: 0 };
    const result = transport.exportTransportTimings();
    const numeric = new Set([
      'nativeEntryWallMs',
      'nativeResumeMs',
      'nativeCompletionMs',
      'nativeCompletionWallMs',
      'nativeResponseReadyMs',
      'nativeResponseReadyWallMs',
      'transactionCount',
      'fetchStartMs',
      'dnsStartMs',
      'dnsEndMs',
      'connectStartMs',
      'connectEndMs',
      'tlsStartMs',
      'tlsEndMs',
      'requestStartMs',
      'requestEndMs',
      'responseStartMs',
      'responseEndMs',
    ]);
    const boolean = new Set([
      'metricsAvailable',
      'failed',
      'transactionsTruncated',
      'reusedConnection',
      'proxyConnection',
    ]);
    const allowedStrings: Record<string, readonly string[]> = {
      route: ['direct', 'tunnel'],
      proxyMode: ['none', 'socks', 'connect'],
      protocol: ['http/1.0', 'http/1.1', 'h2', 'h3', 'other'],
    };
    const sanitize = (input: unknown): Record<string, unknown> => {
      if (!input || typeof input !== 'object') return {};
      const output: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(input)) {
        if (numeric.has(name) && typeof value === 'number' && Number.isFinite(value))
          output[name] = value;
        if (boolean.has(name) && typeof value === 'boolean') output[name] = value;
        if (allowedStrings[name]?.includes(value as string)) output[name] = value;
      }
      return output;
    };
    const records = Array.isArray(result.records)
      ? result.records.slice(-32).flatMap((input: unknown) => {
          if (!input || typeof input !== 'object') return [];
          const record = input as Record<string, unknown>;
          if (
            typeof record.requestId !== 'string' ||
            !/^[a-z0-9-]{1,80}$/.test(record.requestId) ||
            record.requestId.trim() !== record.requestId
          )
            return [];
          return [
            {
              ...sanitize(record),
              requestId: record.requestId,
              transactions: Array.isArray(record.transactions)
                ? record.transactions.slice(-4).map(sanitize)
                : [],
            },
          ];
        })
      : [];
    return {
      available: true,
      records,
      omitted: Number.isSafeInteger(result.omitted) && result.omitted >= 0 ? result.omitted : 0,
    };
  } catch {
    return { available: false, records: [], omitted: 0 };
  }
}
