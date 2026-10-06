import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  isForbiddenAddress,
  redactAllSecretForms,
  redactionOrder,
} from './restricted-http-json-connector.js';

/** Shared broker transport: callers authorize the destination before credentials reach it. */
export type BrokeredHttpStreamTransport = (input: {
  hostname: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: IncomingMessage | Buffer;
  signal: AbortSignal;
}) => Promise<IncomingMessage>;

export const brokeredHttpStreamTransport: BrokeredHttpStreamTransport = async (input) => {
  return await new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = httpsRequest(
      {
        hostname: input.hostname,
        port: 443,
        servername: input.hostname,
        method: input.method,
        path: input.path,
        headers: input.headers,
        agent: false,
        signal: input.signal,
        lookup: (_hostname, lookupOptions, callback) => {
          void lookup(input.hostname, { all: true, verbatim: true }).then(
            (addresses) => {
              if (
                !addresses.length ||
                addresses.some(({ address }) => isForbiddenAddress(address))
              ) {
                callback(new Error('broker destination rejected'), '', 4);
                return;
              }
              if (lookupOptions.all === true) callback(null, addresses);
              else callback(null, addresses[0]!.address, addresses[0]!.family);
            },
            () => callback(new Error('broker destination rejected'), '', 4),
          );
        },
      },
      resolve,
    );
    outgoing.once('error', reject);
    if (Buffer.isBuffer(input.body)) outgoing.end(input.body);
    else {
      input.body.once('aborted', () => outgoing.destroy());
      input.body.once('error', () => outgoing.destroy());
      input.body.pipe(outgoing);
    }
  });
};

/** Keep enough trailing bytes to catch an echoed credential split across chunks.
 * Abort rather than mutate a Git packfile and silently corrupt its object stream.
 * As with the JSON broker, arbitrary upstream transformations cannot be detected. */
export function credentialSafeStream(
  credentials: readonly { value: string; alias: string }[],
): Transform {
  const needles = redactionOrder(credentials);
  const retained = Math.max(1, ...needles.map(({ needle }) => Buffer.byteLength(needle))) - 1;
  let tail = Buffer.alloc(0);
  const check = (chunk: Buffer): void => {
    const text = chunk.toString('latin1');
    if (redactAllSecretForms(text, credentials, needles) !== text) {
      throw new Error('broker response withheld');
    }
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        const combined = Buffer.concat([tail, chunk]);
        check(combined);
        const count = Math.max(0, combined.length - retained);
        if (count) this.push(combined.subarray(0, count));
        tail = Buffer.from(combined.subarray(count));
        callback();
      } catch {
        callback(new Error('broker response withheld'));
      }
    },
    flush(callback) {
      try {
        check(tail);
        this.push(tail);
        tail = Buffer.alloc(0);
        callback();
      } catch {
        callback(new Error('broker response withheld'));
      }
    },
  });
}

const RESPONSE_HEADERS = ['content-type', 'link', 'retry-after', 'x-github-request-id'] as const;

export async function relayBrokeredHttpResponse(
  upstream: IncomingMessage,
  response: ServerResponse,
  credentials: readonly { value: string; alias: string }[],
  signal: AbortSignal,
): Promise<void> {
  const status = upstream.statusCode ?? 502;
  if (
    upstream.headers['content-encoding'] !== undefined &&
    upstream.headers['content-encoding'] !== 'identity'
  ) {
    upstream.destroy();
    throw new Error('encoded broker response rejected');
  }
  // Never forward a redirect carrying an injected credential, even to another provider host.
  if (status >= 300 && status < 400) {
    upstream.destroy();
    throw new Error('broker redirect rejected');
  }
  const needles = redactionOrder(credentials);
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers[name];
    if (typeof value === 'string') {
      response.setHeader(name, redactAllSecretForms(value, credentials, needles));
    }
  }
  response.statusCode = status;
  await pipeline(upstream, credentialSafeStream(credentials), response, { signal });
}
