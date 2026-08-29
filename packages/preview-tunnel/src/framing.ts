/**
 * Wire framing for the preview tunnel, per `docs/UPLINK_CHANNEL_PROTOCOL.md`.
 *
 * Every non-control frame is carried on a **stream**: it is opened, carries
 * ordered data frames, and each direction is closed independently by its sender.
 * That is what makes a response whose last byte never arrives (Server-Sent
 * Events) and a bidirectional WebSocket expressible in the same shape — the
 * previous request/response framing could express neither without a special
 * case per content type.
 *
 * The frame *names* are the protocol's (`stream.open`, …); the discriminator
 * property stays `kind`, which is what the rest of this package already uses.
 */

const MAX_STREAM_ID_CHARACTERS = 128;
const MAX_HEADER_COUNT = 100;
const MAX_HEADER_NAME_CHARACTERS = 100;
const MAX_HEADER_VALUE_CHARACTERS = 8192;

/** WebSocket close reasons are capped at 123 bytes by RFC 6455 §5.5.1, so a
 * longer one could never be forwarded to the peer's close frame anyway. */
const MAX_CLOSE_REASON_BYTES = 123;

/**
 * Close codes a hop may put on the wire. RFC 6455 §7.4.1 reserves 1004, 1005
 * and 1006, and 1015 is set locally by an endpoint that never completed TLS —
 * none of them can be *sent*, and 2000–2999 is reserved for the protocol
 * itself. Accepting one here would mean handing it to `WebSocket.close`, which
 * throws on exactly this set, so a single malformed frame from an authenticated
 * peer would take the relay down with it.
 */
export function sendableCloseCode(code: number): boolean {
  if (!Number.isInteger(code)) return false;
  if (code >= 3000 && code <= 4999) return true;
  return code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006;
}

export const MAX_TUNNEL_HEADER_BYTES = 32 * 1024;
export const MAX_TUNNEL_PATH_CHARACTERS = 8192;
export const MAX_UTF8_BYTES_PER_CHARACTER = 4;
export const MAX_JSON_ESCAPE_EXPANSION = 2;
export const TUNNEL_FRAME_FIXED_BYTES = 4096;

export const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export type StreamChannel = 'http' | 'ws';

/**
 * `stream.reset` codes. `protocol_error` is the only one raised against a peer
 * that broke the contract; the rest report a bound this side enforced.
 */
export const STREAM_RESET_CODES = [
  'timeout',
  'client_gone',
  'body_limit',
  'concurrency_limit',
  'share_ended',
  'upstream_error',
  'protocol_error',
] as const;

export type StreamResetCode = (typeof STREAM_RESET_CODES)[number];

/** Opens the request direction of an `http` stream. */
export interface HttpRequestMeta {
  method: string;
  path: string;
  headers: Record<string, string>;
}

/**
 * Opens the response direction of an `http` stream, reusing the request's
 * `streamId`. This second open is required rather than optional: it is the only
 * frame carrying a status line, so there is nowhere else for one to go.
 */
export interface HttpResponseMeta {
  status: number;
  headers: Record<string, string>;
}

/** Opens the dial direction of a `ws` stream. */
export interface WsOpenMeta {
  path: string;
  headers: Record<string, string>;
}

/**
 * Opens the reply direction of a `ws` stream, reusing the dial's `streamId`.
 * Like an http response head this second open is required, and for the same
 * reason: it is the only frame that reports the target accepted the socket, and
 * it carries the subprotocol the target selected. Without it the dialling hop
 * would have to answer its own client before knowing either.
 */
export interface WsAcceptMeta {
  protocol?: string;
}

export interface StreamOpen {
  kind: 'stream.open';
  streamId: string;
  channel: StreamChannel;
  meta: HttpRequestMeta | HttpResponseMeta | WsOpenMeta | WsAcceptMeta;
}

export interface StreamData {
  kind: 'stream.data';
  streamId: string;
  /** Starts at 0 and increments by one, counted per stream **per direction**. */
  seq: number;
  /** base64; on `ws` one frame carries exactly one WebSocket message. */
  payload: string;
  meta?: { opcode?: 'text' | 'binary' };
}

/** Half-close: ends the sending direction only. The stream is fully closed once
 * both directions have ended, or at any point by `stream.reset`. Treating this
 * as a full close would truncate every response whose request body ends first —
 * which is all of them. */
export interface StreamEnd {
  kind: 'stream.end';
  streamId: string;
  /** On `ws`, the peer's close status, so it reaches the other endpoint intact. */
  meta?: { code?: number; reason?: string };
}

export interface StreamReset {
  kind: 'stream.reset';
  streamId: string;
  code: StreamResetCode;
}

export type StreamFrame = StreamOpen | StreamData | StreamEnd | StreamReset;

/**
 * Ceiling for a single encoded frame: the base64 body plus a worst-case
 * envelope. Sized so an oversized frame is refused by the WebSocket layer
 * before it is ever decoded.
 */
export function encodedPayloadLimit(bodyBytes: number): number {
  const pathBytes = MAX_TUNNEL_PATH_CHARACTERS * MAX_UTF8_BYTES_PER_CHARACTER;
  const escapedEnvelopeBytes = (MAX_TUNNEL_HEADER_BYTES + pathBytes) * MAX_JSON_ESCAPE_EXPANSION;
  return Math.ceil(bodyBytes / 3) * 4 + escapedEnvelopeBytes + TUNNEL_FRAME_FIXED_BYTES;
}

/**
 * One encoding per byte string, checked without decoding. Beyond the alphabet
 * and whole quanta, the last character of a padded quantum has bits that no byte
 * reaches: `AB==` and `AA==` decode alike, and a decoder that ignores the
 * difference lets one payload arrive under two spellings. Restricting that
 * character to the values whose spare bits are zero rules the second spelling
 * out — `[AQgw]` leaves four spare bits clear, `[AEIMQUYcgkosw048]` leaves two.
 */
export function canonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  if (value.endsWith('==')) return /[AQgw]==$/.test(value);
  if (value.endsWith('=')) return /[AEIMQUYcgkosw048]=$/.test(value);
  return true;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function headerBytes(headers: Record<string, string>): number {
  return Object.entries(headers).reduce(
    (total, [name, value]) => total + Buffer.byteLength(name) + Buffer.byteLength(value) + 4,
    0,
  );
}

/** Control characters would let a peer inject a header or request line into
 * the receiving hop's socket, so they are rejected rather than stripped. */
function hasInvalidHeaderValueCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9) || code === 127) return true;
  }
  return false;
}

export function validHeaders(
  value: unknown,
  forbidden: ReadonlySet<string>,
): value is Record<string, string> {
  if (!isStringRecord(value) || Object.keys(value).length > MAX_HEADER_COUNT) return false;
  if (headerBytes(value) > MAX_TUNNEL_HEADER_BYTES) return false;
  return Object.entries(value).every(([rawName, headerValue]) => {
    const name = rawName.toLowerCase();
    return (
      /^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name) &&
      name.length <= MAX_HEADER_NAME_CHARACTERS &&
      headerValue.length <= MAX_HEADER_VALUE_CHARACTERS &&
      !hasInvalidHeaderValueCharacters(headerValue) &&
      !HOP_BY_HOP.has(name) &&
      !forbidden.has(name)
    );
  });
}

/** `host` and `cookie` are set by the receiving hop, never forwarded. */
export const FORBIDDEN_REQUEST_HEADERS: ReadonlySet<string> = new Set(['host', 'cookie']);

/** `set-cookie` would escape the share's cookie isolation; `content-length` is
 * re-derived by the receiving hop and a stale one would desynchronise it. */
export const FORBIDDEN_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'set-cookie',
  'content-length',
]);

function validStreamId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_STREAM_ID_CHARACTERS;
}

function validPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    value.length <= MAX_TUNNEL_PATH_CHARACTERS &&
    !hasInvalidHeaderValueCharacters(value)
  );
}

export function isHttpResponseMeta(value: unknown): value is HttpResponseMeta {
  if (typeof value !== 'object' || value === null) return false;
  const meta = value as Partial<HttpResponseMeta>;
  return (
    Number.isInteger(meta.status) &&
    meta.status !== undefined &&
    meta.status >= 200 &&
    meta.status <= 599 &&
    validHeaders(meta.headers, FORBIDDEN_RESPONSE_HEADERS)
  );
}

export function isHttpRequestMeta(value: unknown): value is HttpRequestMeta {
  if (typeof value !== 'object' || value === null) return false;
  const meta = value as Partial<HttpRequestMeta>;
  return (
    typeof meta.method === 'string' &&
    /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(meta.method) &&
    validPath(meta.path) &&
    validHeaders(meta.headers, FORBIDDEN_REQUEST_HEADERS)
  );
}

export function isWsOpenMeta(value: unknown): value is WsOpenMeta {
  if (typeof value !== 'object' || value === null) return false;
  const meta = value as Partial<WsOpenMeta>;
  return validPath(meta.path) && validHeaders(meta.headers, FORBIDDEN_REQUEST_HEADERS);
}

/**
 * A subprotocol is an RFC 7230 token: the `Sec-WebSocket-Protocol` grammar is a
 * comma-separated list of them, so anything holding a separator or a space is
 * not one element of that list but a malformed offer.
 */
export function isSubprotocolToken(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_HEADER_VALUE_CHARACTERS &&
    /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)
  );
}

/** A selected subprotocol is one token from the dial's own offer, so it is
 * bounded by what a header value may hold and may not contain a separator. */
export function isWsAcceptMeta(value: unknown): value is WsAcceptMeta {
  if (typeof value !== 'object' || value === null) return false;
  // Unknown members are tolerated by design, but members that belong to another
  // meta are not: an acceptance carrying a status line or a path is a frame
  // whose sender confused two channels, and reading it as an empty accept would
  // let that confusion through.
  for (const claimed of ['status', 'path', 'method', 'headers']) {
    if (claimed in value) return false;
  }
  const { protocol } = value as { protocol?: unknown };
  if (protocol === undefined) return true;
  return typeof protocol === 'string' && isSubprotocolToken(protocol);
}

/**
 * Validates a decoded frame. Unknown `meta` members are tolerated by design so a
 * channel can add its own without a protocol version bump; the members defined
 * today are checked strictly.
 */
export function validStreamFrame(value: unknown, maxBodyBytes: number): value is StreamFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as { kind?: unknown; streamId?: unknown };
  if (!validStreamId(frame.streamId)) return false;
  switch (frame.kind) {
    case 'stream.open': {
      const open = value as Partial<StreamOpen>;
      if (open.channel === 'http') {
        return isHttpRequestMeta(open.meta) || isHttpResponseMeta(open.meta);
      }
      if (open.channel === 'ws') return isWsOpenMeta(open.meta) || isWsAcceptMeta(open.meta);
      return false;
    }
    case 'stream.data': {
      const data = value as Partial<StreamData>;
      if (!Number.isSafeInteger(data.seq) || data.seq === undefined || data.seq < 0) return false;
      if (typeof data.payload !== 'string' || !canonicalBase64(data.payload)) return false;
      // Encoded length first, so an oversized payload is rejected before it is
      // decoded into memory. This bounds one frame; the cumulative body of a
      // stream is the registry's job, since framing sees frames in isolation.
      if (data.payload.length > Math.ceil(maxBodyBytes / 3) * 4) return false;
      if (Buffer.from(data.payload, 'base64').byteLength > maxBodyBytes) return false;
      if (data.meta !== undefined) {
        if (typeof data.meta !== 'object' || data.meta === null) return false;
        const opcode = (data.meta as { opcode?: unknown }).opcode;
        if (opcode !== undefined && opcode !== 'text' && opcode !== 'binary') return false;
      }
      return true;
    }
    case 'stream.end': {
      const end = value as Partial<StreamEnd>;
      if (end.meta === undefined) return true;
      if (typeof end.meta !== 'object' || end.meta === null) return false;
      const { code, reason } = end.meta as { code?: unknown; reason?: unknown };
      if (code !== undefined && (typeof code !== 'number' || !sendableCloseCode(code))) {
        return false;
      }
      if (
        reason !== undefined &&
        (typeof reason !== 'string' || Buffer.byteLength(reason) > MAX_CLOSE_REASON_BYTES)
      ) {
        return false;
      }
      // A close frame carries its reason behind the status code, so RFC 6455
      // §5.5.1 has no way to send one without the other. Accepting the pair
      // would mean silently dropping the reason at the far hop, which reads as a
      // relay that loses data rather than as the malformed frame it is.
      if (reason !== undefined && code === undefined) return false;
      return true;
    }
    case 'stream.reset': {
      const reset = value as Partial<StreamReset>;
      return STREAM_RESET_CODES.includes(reset.code as StreamResetCode);
    }
    default:
      return false;
  }
}
