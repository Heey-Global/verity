import { requireNativeModule } from 'expo-modules-core';
import {
  directRouteKnownReachable,
  lastDirectRefusal,
  pendingDirectVerdict,
  recoverRemoteControlRead,
  remoteControlFailureForUrl,
  remoteControlPortForUrl,
  reportDirectRouteFailure,
  reportDirectRouteSuccess,
} from './remoteControlTransport';

interface NativeResponse {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
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
  ): Promise<NativeResponse>;
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
  addListener(
    event: 'onWebSocketEvent',
    listener: (event: {
      id: string;
      type: 'open' | 'message' | 'error' | 'close';
      data?: string;
    }) => void,
  ): { remove(): void };
}

export async function downloadPinnedFile(input: {
  url: string;
  headers?: Record<string, string>;
  destination: string;
  tlsPin: string;
  useRemote?: boolean;
}): Promise<string> {
  const port = input.useRemote ? await remoteControlPortForUrl(input.url) : 0;
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
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (input instanceof Request)
      throw new Error('Request objects are not supported by the pinned transport.');
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
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
    try {
      const encodedBody = fileUri ? null : await encodeBody(init.body);
      const replayable =
        !fileUri && (init.method ?? 'GET').toUpperCase() === 'GET' && encodedBody === null;
      const port = useRemote ? await remoteControlPortForUrl(url, replayable) : 0;
      if (init.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      // A read sent directly while the route is unknown must not sit in a
      // request timeout: a definite refusal from the capped probe cancels it
      // at once, and a probe timeout grants it a few more seconds, which a
      // waking VPN needs and a blackholed address does not deserve.
      let settled = false;
      let cancelledBy: 'verdict' | 'grace' | null = null;
      let grace: ReturnType<typeof setTimeout> | undefined;
      // Non-null only for a read sent while the route was untested; a read the
      // known-good direct route loses fails as before, without an Uplink detour.
      const verdict = useRemote && replayable && port === 0 ? pendingDirectVerdict(url) : null;
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
          : await transport.request(
              requestId,
              url,
              init.method ?? 'GET',
              headers,
              encodedBody,
              tlsPin,
              port,
            );
        settled = true;
        if (useRemote && port === 0 && !init.signal?.aborted) reportDirectRouteSuccess(url);
      } catch (error) {
        settled = true;
        let directFailed = port === 0;
        let failure: Error = error instanceof Error ? error : new Error('native transport error');
        if (
          port > 0 &&
          replayable &&
          failure.message.includes('NO_AUTH_CHALLENGE') &&
          !init.signal?.aborted &&
          (await recoverRemoteControlRead(url, port))
        ) {
          if (init.signal?.aborted)
            throw new DOMException('The operation was aborted.', 'AbortError');
          try {
            response = await transport.request(requestId, url, 'GET', headers, null, tlsPin, port);
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
            // A failed read has no uncertain mutation to replay. Keep the same
            // paired URL and pin when a reachable direct route can recover it.
            response = await transport.request(requestId, url, 'GET', headers, null, tlsPin, 0);
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
        if (useRemote && directFailed && !init.signal?.aborted) reportDirectRouteFailure(url);
        let remoteAttempted = false;
        let remoteReason: string | null = null;
        if (
          !recovered &&
          verdict !== null &&
          port === 0 &&
          useRemote &&
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
            remoteAttempted = true;
            try {
              response = await transport.request(
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
          const skipped = port === 0 && useRemote ? remoteControlFailureForUrl(url) : null;
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

type SocketListener = (event: { data: unknown }) => void;

export function createPinnedWebSocket(
  url: string,
  tlsPin: string,
  protocols: string | string[] = [],
  useRemote = false,
) {
  const listeners = new Map<'message' | 'close' | 'error', Set<SocketListener>>();
  let socketId: string | null = null;
  let closed = false;
  const subscription = native().addListener('onWebSocketEvent', (event) => {
    if (event.id !== socketId) return;
    if (event.type === 'open') return;
    if (event.type === 'message' || event.type === 'close' || event.type === 'error') {
      for (const listener of listeners.get(event.type) ?? []) listener({ data: event.data });
    }
    if (event.type === 'close') subscription.remove();
  });
  void (async () => {
    const port = useRemote ? await remoteControlPortForUrl(url) : 0;
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
    addEventListener(type: 'message' | 'close' | 'error', listener: SocketListener) {
      const registered = listeners.get(type) ?? new Set<SocketListener>();
      registered.add(listener);
      listeners.set(type, registered);
    },
    close() {
      closed = true;
      if (socketId !== null) void native().closeWebSocket(socketId);
      subscription.remove();
    },
  };
}
