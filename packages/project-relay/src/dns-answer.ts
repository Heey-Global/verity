import { request } from 'node:http';
import { isIP } from 'node:net';

/**
 * Controlled DNS answers for a fenced project Sandbox.
 *
 * Under the project fence the relay never forwards a query to another resolver: it
 * parses one question and answers only with the addresses the host admitted for a
 * current direct grant of this project generation, as reported by the Server over
 * the project-bound broker socket. Every other name is refused, so a query cannot
 * carry data to an outside resolver and a Sandbox cannot learn unadmitted addresses.
 */

const TYPE_A = 1;
const TYPE_AAAA = 28;
const CLASS_IN = 1;
const RCODE_FORMERR = 1;
const RCODE_SERVFAIL = 2;
const RCODE_REFUSED = 5;

export interface DnsQuestion {
  id: number;
  recursionDesired: boolean;
  /** Lowercase, without the trailing dot. */
  name: string;
  type: number;
  /** The raw question section, echoed in the response. */
  question: Buffer;
}

/** Exactly one IN question, no compression, no answer/authority records. */
export function parseDnsQuery(message: Buffer): DnsQuestion | undefined {
  if (message.length < 12 || message.length > 4096) return undefined;
  const flags = message.readUInt16BE(2);
  // QR must be a query and OPCODE a standard query.
  if (flags & 0x8000 || (flags >> 11) & 0x0f) return undefined;
  if (
    message.readUInt16BE(4) !== 1 ||
    message.readUInt16BE(6) !== 0 ||
    message.readUInt16BE(8) !== 0 ||
    message.readUInt16BE(10) > 1
  )
    return undefined;
  const labels: string[] = [];
  let offset = 12;
  let total = 0;
  for (;;) {
    if (offset >= message.length) return undefined;
    const length = message[offset]!;
    offset += 1;
    if (length === 0) break;
    // Compression pointers and extended label types are not valid in a question here.
    if (length > 63 || offset + length > message.length) return undefined;
    const label = message.subarray(offset, offset + length).toString('latin1');
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label)) return undefined;
    labels.push(label.toLowerCase());
    total += length + 1;
    if (total > 254) return undefined;
    offset += length;
  }
  if (!labels.length || offset + 4 > message.length) return undefined;
  const type = message.readUInt16BE(offset);
  if (message.readUInt16BE(offset + 2) !== CLASS_IN) return undefined;
  return {
    id: message.readUInt16BE(0),
    recursionDesired: (flags & 0x0100) !== 0,
    name: labels.join('.'),
    type,
    question: message.subarray(12, offset + 4),
  };
}

/** A minimal response carrying no additional or authority records. */
export function buildDnsResponse(
  query: DnsQuestion,
  rcode: number,
  addresses: readonly string[] = [],
  ttlSeconds = 1,
): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.id, 0);
  // QR, RA and the client's RD; never authoritative.
  header.writeUInt16BE(0x8080 | (query.recursionDesired ? 0x0100 : 0) | (rcode & 0x0f), 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(addresses.length, 6);
  const answers = addresses.map((address) => {
    const v4 = isIP(address) === 4;
    const data = v4
      ? Buffer.from(address.split('.').map(Number))
      : Buffer.from(expandIpv6(address), 'hex');
    const record = Buffer.alloc(12);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(v4 ? TYPE_A : TYPE_AAAA, 2);
    record.writeUInt16BE(CLASS_IN, 4);
    record.writeUInt32BE(ttlSeconds, 6);
    record.writeUInt16BE(data.length, 10);
    return Buffer.concat([record, data]);
  });
  return Buffer.concat([header, query.question, ...answers]);
}

function expandIpv6(address: string): string {
  const [head = '', tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = address.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = address.includes('::')
    ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return groups.map((group) => group.padStart(4, '0')).join('');
}

export interface DirectNameAnswer {
  granted: boolean;
  addresses: readonly string[];
  ttlSeconds: number;
}

/** Ask the Server, over the project-bound broker socket, for host-admitted addresses. */
export function brokerNameLookup(
  socketPath: string,
  timeoutMs = 2_000,
): (name: string, type: 'A' | 'AAAA') => Promise<DirectNameAnswer> {
  return (name, type) =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify({ name, type });
      const call = request(
        {
          socketPath,
          method: 'POST',
          path: '/internal/dns',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
          timeout: timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 8192) call.destroy(new Error('Oversized name answer'));
            else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              if (response.statusCode !== 200) throw new Error('Name authority refused');
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as DirectNameAnswer;
              const family = type === 'A' ? 4 : 6;
              if (
                typeof value.granted !== 'boolean' ||
                !Array.isArray(value.addresses) ||
                value.addresses.length > 32 ||
                (value.addresses as unknown[]).some(
                  (address) => typeof address !== 'string' || isIP(address) !== family,
                ) ||
                !Number.isInteger(value.ttlSeconds) ||
                value.ttlSeconds < 1 ||
                value.ttlSeconds > 5
              )
                throw new Error('Invalid name answer');
              resolve(value);
            } catch (error) {
              reject(error instanceof Error ? error : new Error('Invalid name answer'));
            }
          });
        },
      );
      call.on('timeout', () => call.destroy(new Error('Name authority timed out')));
      call.on('error', reject);
      call.end(body);
    });
}

/** One controlled answer; undefined drops a message that is not a valid query. */
export async function answerDnsQuery(
  message: Buffer,
  lookup: (name: string, type: 'A' | 'AAAA') => Promise<DirectNameAnswer>,
): Promise<Buffer | undefined> {
  const query = parseDnsQuery(message);
  if (!query) {
    // A reply needs at least the header to carry the client's ID; responses are dropped.
    if (message.length < 12 || message.readUInt16BE(2) & 0x8000) return undefined;
    const header = Buffer.from(message.subarray(0, 12));
    header.writeUInt16BE(0x8080 | RCODE_FORMERR, 2);
    header.fill(0, 4, 12);
    return header;
  }
  try {
    const type = query.type === TYPE_AAAA ? 'AAAA' : 'A';
    const answer = await lookup(query.name, type);
    if (!answer.granted) return buildDnsResponse(query, RCODE_REFUSED);
    // Other record types of a granted name exist only as empty answers.
    if (query.type !== TYPE_A && query.type !== TYPE_AAAA) return buildDnsResponse(query, 0);
    // A subset of admitted addresses keeps every answer within a classic 512-byte reply.
    const limit = Math.floor(
      (512 - 12 - query.question.length) / (query.type === TYPE_A ? 16 : 28),
    );
    return buildDnsResponse(query, 0, answer.addresses.slice(0, limit), answer.ttlSeconds);
  } catch {
    return buildDnsResponse(query, RCODE_SERVFAIL);
  }
}
