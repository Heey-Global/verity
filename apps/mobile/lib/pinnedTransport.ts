import { requireNativeModule } from 'expo-modules-core';
import {
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
    let response: NativeResponse;
    try {
      const encodedBody = fileUri ? null : await encodeBody(init.body);
      const replayable =
        !fileUri && (init.method ?? 'GET').toUpperCase() === 'GET' && encodedBody === null;
      const port = useRemote ? await remoteControlPortForUrl(url, replayable) : 0;
      if (init.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
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
        if (useRemote && port === 0 && !init.signal?.aborted) reportDirectRouteSuccess(url);
      } catch (error) {
        let directFailed = port === 0;
        if (
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
            return new Response(utf8ResponseBody(response), {
              status: response.status,
              headers: response.headers,
            });
          } catch (directError) {
            if (init.signal?.aborted) throw directError;
            error = directError;
            directFailed = true;
          }
        }
        if (useRemote && directFailed && !init.signal?.aborted) reportDirectRouteFailure(url);
        let remoteAttempted = false;
        if (port === 0 && useRemote && directFailed && replayable && !init.signal?.aborted) {
          // The direct route was tried first without knowing whether it works.
          // A read that it lost is recovered through Uplink, which the failure
          // just made the route for the requests that follow.
          let remotePort = 0;
          try {
            remotePort = await remoteControlPortForUrl(url);
          } catch {
            // Admission failures are reported by remoteControlFailureForUrl below.
          }
          if (remotePort > 0 && !init.signal?.aborted) {
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
              return new Response(utf8ResponseBody(response), {
                status: response.status,
                headers: response.headers,
              });
            } catch (remoteError) {
              if (init.signal?.aborted) throw remoteError;
              // The direct failure stays the reported reason: that is the
              // route the label leads with, and the Uplink failure is kept by
              // remoteControlFailureForUrl for the next attempt.
            }
          }
        }
        const failure = port === 0 && useRemote ? remoteControlFailureForUrl(url) : null;
        const route =
          port > 0
            ? (init.method ?? 'GET').toUpperCase() === 'GET' && !fileUri && encodedBody === null
              ? 'Uplink and direct Core requests'
              : 'Uplink Core request'
            : remoteAttempted
              ? 'Direct and Uplink Core requests'
              : failure === null
                ? 'Direct Core request'
                : `Uplink ${failure} and direct Core request`;
        const reason =
          error instanceof Error
            ? (error.message.match(
                /Pinned TLS (?:transport|verification) failed \[[^\]]{1,150}\]/u,
              )?.[0] ?? 'native transport error')
            : 'native transport error';
        const diagnostic = new Error(`${route} failed: ${reason}`);
        diagnostic.name = 'VerityConnectionError';
        throw diagnostic;
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
