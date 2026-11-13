import { getRandomBytes } from 'expo-crypto';

// The app's one request of a team join on Uplink's admission socket (team
// bootstrap interface v1). Uplink mints the redemption; the app never makes one.
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const TICKET = /^[A-Za-z0-9_-]{1,512}$/u;
const MAX_FRAME_BYTES = 16 * 1024;
const CAPABILITY = 'team-bootstrap-v1';
const ERROR_CODES = new Set([
  'unavailable',
  'rate_limited',
  'limit_reached',
  'protocol_unsupported',
  'timeout',
  'cancelled',
  'internal',
]);

export interface TeamJoinAdmission {
  readonly sessionId: string;
  readonly redemptionId: string;
  readonly ticket: string;
  readonly expiresAt: number;
  /** Close the admission socket once the tunnel is attached; ends nothing else. */
  finish(): void;
}

export class TeamJoinAdmissionError extends Error {
  constructor(readonly code: string) {
    super(`Team join admission failed: ${code}.`);
  }
}

function admissionUrl(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Team join admission requires an HTTPS Uplink origin.');
  url.protocol = 'wss:';
  url.pathname = '/remote-control';
  return url.href;
}

function requestId(): string {
  let binary = '';
  for (const byte of getRandomBytes(16)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

const exactly = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export function requestTeamJoinAdmission(options: {
  uplinkOrigin: string;
  installationHandle: string;
  invitationId: string;
  socketFactory?: (url: string) => WebSocket;
}): Promise<TeamJoinAdmission> {
  const url = admissionUrl(options.uplinkOrigin);
  const id = requestId();
  const socket = (options.socketFactory ?? ((target) => new WebSocket(target)))(url);
  let settled = false;
  return new Promise<TeamJoinAdmission>((resolve, reject) => {
    const close = () => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      close();
      reject(error);
    };
    // Uplink decides within 15 seconds of the request; allow for the round trips.
    const timer = setTimeout(() => fail(new TeamJoinAdmissionError('timeout')), 25_000);
    socket.addEventListener('open', () => {
      try {
        socket.send(
          JSON.stringify({
            type: 'team.join.reserve',
            requestId: id,
            installationHandle: options.installationHandle,
            invitationId: options.invitationId,
            capabilities: [CAPABILITY],
          }),
        );
      } catch {
        fail(new Error('Team join admission connection failed.'));
      }
    });
    socket.addEventListener('message', (event) => {
      if (settled) return;
      if (typeof event.data !== 'string' || event.data.length > MAX_FRAME_BYTES) {
        fail(new Error('Invalid team join admission response.'));
        return;
      }
      let frame: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        frame = parsed as Record<string, unknown>;
      } catch {
        fail(new Error('Invalid team join admission response.'));
        return;
      }
      if (
        frame.type === 'team.join.error' &&
        (exactly(frame, ['type', 'requestId', 'code']) ||
          exactly(frame, ['type', 'requestId', 'code', 'retryAfterMs'])) &&
        frame.requestId === id &&
        typeof frame.code === 'string' &&
        ERROR_CODES.has(frame.code)
      ) {
        fail(new TeamJoinAdmissionError(frame.code));
        return;
      }
      if (
        frame.type !== 'team.join.ready' ||
        !exactly(frame, [
          'type',
          'requestId',
          'sessionId',
          'redemptionId',
          'ticket',
          'expiresAt',
          'capability',
        ]) ||
        frame.requestId !== id ||
        typeof frame.sessionId !== 'string' ||
        !ID.test(frame.sessionId) ||
        typeof frame.redemptionId !== 'string' ||
        !ID.test(frame.redemptionId) ||
        typeof frame.ticket !== 'string' ||
        !TICKET.test(frame.ticket) ||
        !Number.isSafeInteger(frame.expiresAt) ||
        frame.capability !== CAPABILITY
      ) {
        fail(new Error('Invalid team join admission response.'));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        sessionId: frame.sessionId,
        redemptionId: frame.redemptionId,
        ticket: frame.ticket,
        expiresAt: frame.expiresAt as number,
        finish: close,
      });
    });
    socket.addEventListener('error', () =>
      fail(new Error('Team join admission connection failed.')),
    );
    socket.addEventListener('close', () =>
      fail(new Error('Team join admission connection closed.')),
    );
  });
}
