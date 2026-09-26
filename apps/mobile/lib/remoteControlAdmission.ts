import { getRandomBytes } from 'expo-crypto';

const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_FRAME_BYTES = 16 * 1024;
const CAPABILITY = 'remote-control-v1';
const ERROR_CODES = new Set([
  'unavailable',
  'rate_limited',
  'limit_reached',
  'protocol_unsupported',
  'timeout',
  'cancelled',
  'internal',
]);

export interface RemoteAdmission {
  readonly sessionId: string;
  readonly ticket: string;
  readonly expiresAt: number;
  /** Close the admission socket after /data reports `attached`. */
  finish(): void;
  /** Cancel admission or an attachment that has not yet become active. */
  cancel(): void;
}

export interface RemoteAdmissionOptions {
  uplinkOrigin: string;
  installationHandle: string;
  signal?: AbortSignal;
  socketFactory?: (url: string) => WebSocket;
}

function admissionUrl(origin: string): string {
  const url = new URL(origin);
  if (
    url.protocol !== 'https:' ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error('Remote admission requires an HTTPS Uplink origin.');
  }
  url.protocol = 'wss:';
  url.pathname = '/remote-control';
  return url.href;
}

function requestId(): string {
  let binary = '';
  for (const byte of getRandomBytes(16)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function fields(value: Record<string, unknown>, expected: string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

/** One ticket request; the caller keeps admission open until the data barrier completes. */
export function requestRemoteControlAdmission(
  options: RemoteAdmissionOptions,
): Promise<RemoteAdmission> {
  const url = admissionUrl(options.uplinkOrigin);
  if (!ID.test(options.installationHandle)) throw new Error('Invalid remote installation handle.');
  if (options.signal?.aborted) return Promise.reject(new Error('Remote admission cancelled.'));

  const id = requestId();
  const socket = (options.socketFactory ?? ((target) => new WebSocket(target)))(url);
  let state: 'pending' | 'ready' | 'done' = 'pending';
  let opened = false;

  return new Promise<RemoteAdmission>((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('Remote admission timed out.')), 20_000);
    const close = (cancel: boolean): void => {
      if (state === 'done') return;
      if (cancel && opened) {
        try {
          socket.send(JSON.stringify({ type: 'connect.cancel', requestId: id }));
        } catch {
          // Closing the socket still cancels admission if the send has already failed.
        }
      }
      state = 'done';
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      socket.close();
    };
    const fail = (error: Error): void => {
      if (state !== 'pending') return;
      close(false);
      reject(error);
    };
    const onAbort = (): void => {
      if (state === 'pending') {
        close(true);
        reject(new Error('Remote admission cancelled.'));
      } else close(true);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    socket.addEventListener('open', () => {
      if (state !== 'pending') return;
      opened = true;
      try {
        socket.send(
          JSON.stringify({
            type: 'connect',
            requestId: id,
            installationHandle: options.installationHandle,
            capabilities: [CAPABILITY],
          }),
        );
      } catch {
        fail(new Error('Remote admission connection failed.'));
      }
    });
    socket.addEventListener('message', (event) => {
      if (state !== 'pending') return;
      if (
        typeof event.data !== 'string' ||
        event.data.length > MAX_FRAME_BYTES ||
        new TextEncoder().encode(event.data).byteLength > MAX_FRAME_BYTES
      ) {
        fail(new Error('Invalid remote admission response.'));
        return;
      }
      let frame: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        frame = parsed as Record<string, unknown>;
      } catch {
        fail(new Error('Invalid remote admission response.'));
        return;
      }
      if (
        frame.type === 'connect.error' &&
        (fields(frame, ['type', 'requestId', 'code']) ||
          fields(frame, ['type', 'requestId', 'code', 'retryAfterMs'])) &&
        frame.requestId === id &&
        typeof frame.code === 'string' &&
        ERROR_CODES.has(frame.code) &&
        (frame.retryAfterMs === undefined ||
          (frame.code === 'rate_limited' &&
            Number.isSafeInteger(frame.retryAfterMs) &&
            (frame.retryAfterMs as number) >= 1_000 &&
            (frame.retryAfterMs as number) <= 60_000))
      ) {
        fail(new Error(`Remote admission failed: ${frame.code}.`));
        return;
      }
      if (
        frame.type !== 'connect.ready' ||
        !fields(frame, ['type', 'requestId', 'sessionId', 'ticket', 'expiresAt', 'capability']) ||
        frame.requestId !== id ||
        typeof frame.sessionId !== 'string' ||
        !ID.test(frame.sessionId) ||
        typeof frame.ticket !== 'string' ||
        !ID.test(frame.ticket) ||
        !Number.isSafeInteger(frame.expiresAt) ||
        (frame.expiresAt as number) <= 0 ||
        frame.capability !== CAPABILITY
      ) {
        fail(new Error('Invalid remote admission response.'));
        return;
      }
      state = 'ready';
      clearTimeout(timer);
      resolve({
        sessionId: frame.sessionId as string,
        ticket: frame.ticket as string,
        expiresAt: frame.expiresAt as number,
        finish: () => close(false),
        cancel: () => close(true),
      });
    });
    socket.addEventListener('error', () => fail(new Error('Remote admission connection failed.')));
    socket.addEventListener('close', () => fail(new Error('Remote admission connection closed.')));
  });
}
