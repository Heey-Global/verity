import { requireNativeModule } from 'expo-modules-core';

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
  ): Promise<NativeResponse>;
  download(
    url: string,
    headers: Record<string, string>,
    destination: string,
    tlsPin: string,
  ): Promise<{ status: number; uri: string }>;
  upload(
    requestId: string,
    url: string,
    method: string,
    headers: Record<string, string>,
    source: string,
    tlsPin: string,
  ): Promise<NativeResponse>;
  cancelRequest(requestId: string): Promise<void>;
  verifyIdentity(
    identityKey: string,
    serverId: string,
    challenge: string,
    signature: string,
  ): Promise<boolean>;
  openWebSocket(url: string, tlsPin: string, protocols: string[]): Promise<string>;
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
}): Promise<string> {
  const response = await native().download(
    input.url,
    input.headers ?? {},
    input.destination,
    input.tlsPin,
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

export function createPinnedFetch(tlsPin: string): typeof fetch {
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
      if (init.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      response = fileUri
        ? await transport.upload(requestId, url, init.method ?? 'POST', headers, fileUri, tlsPin)
        : await transport.request(
            requestId,
            url,
            init.method ?? 'GET',
            headers,
            encodedBody,
            tlsPin,
          );
    } catch (error) {
      if (init.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      throw error;
    } finally {
      init.signal?.removeEventListener('abort', onAbort);
    }
    const body = [204, 205, 304].includes(response.status)
      ? null
      : base64ToBuffer(response.bodyBase64);
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
  void native()
    .openWebSocket(url, tlsPin, typeof protocols === 'string' ? [protocols] : protocols)
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
