// Review-only byte decoder. Production enrollment routes do not import this file.
import { accepts, type SchemaName } from './schemas.js';

const utf8 = new TextDecoder('utf-8', { fatal: true });
const qrPrefix = 'verity://enroll/v1#';

function rejectDuplicateKeys(source: string): void {
  let position = 0;
  const whitespace = () => {
    while (/\s/u.test(source[position] ?? '')) position++;
  };
  const string = (): string => {
    const start = position++;
    while (position < source.length) {
      const char = source[position++];
      if (char === '\\') position++;
      else if (char === '"') return JSON.parse(source.slice(start, position)) as string;
    }
    throw new Error('unterminated JSON string');
  };
  const value = (): void => {
    whitespace();
    const first = source[position];
    if (first === '{') {
      position++;
      whitespace();
      const seen = new Set<string>();
      while (source[position] !== '}') {
        const key = string();
        if (seen.has(key)) throw new Error('duplicate JSON key');
        seen.add(key);
        whitespace();
        position++; // JSON.parse has already established that this is a colon.
        value();
        whitespace();
        if (source[position] !== ',') break;
        position++;
        whitespace();
      }
      position++;
    } else if (first === '[') {
      position++;
      whitespace();
      while (source[position] !== ']') {
        value();
        whitespace();
        if (source[position] !== ',') break;
        position++;
      }
      position++;
    } else if (first === '"') {
      string();
    } else {
      while (position < source.length && !/[\s,}\]]/u.test(source[position]!)) position++;
    }
  };
  value();
}

export function decodeStrictJson(bytes: Uint8Array, maximumBytes: number): unknown {
  if (bytes.length === 0 || bytes.length > maximumBytes) throw new Error('JSON byte limit');
  const source = utf8.decode(bytes);
  const value: unknown = JSON.parse(source);
  rejectDuplicateKeys(source);
  return value;
}

export function decodePrefaceFrame(frame: Uint8Array): unknown {
  if (frame.length < 4) throw new Error('missing preface length');
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const length = view.getUint32(0, false);
  if (length === 0 || length > 4096 || frame.length !== 4 + length)
    throw new Error('preface length mismatch');
  const value = decodeStrictJson(frame.subarray(4), 4096);
  if (!accepts('preface', value)) throw new Error('invalid preface');
  return value;
}

export function decodeEnrollmentBody(schema: SchemaName, bytes: Uint8Array): unknown {
  const value = decodeStrictJson(bytes, 16 * 1024);
  if (!accepts(schema, value)) throw new Error('invalid enrollment body');
  return value;
}

export function decodeQrPayload(uri: string): unknown {
  if (!uri.startsWith(qrPrefix)) throw new Error('invalid enrollment QR prefix');
  const encoded = uri.slice(qrPrefix.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error('invalid enrollment QR encoding');
  if (encoded.length > Math.ceil((4096 * 4) / 3)) throw new Error('JSON byte limit');
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded) throw new Error('noncanonical enrollment QR');
  // The complete invitation schema remains a separate contract decision.
  return decodeStrictJson(bytes, 4096);
}
