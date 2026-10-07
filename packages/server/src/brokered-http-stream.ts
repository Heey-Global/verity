import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable, Transform } from 'node:stream';
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
      let bytes = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > 2 * 1024 ** 3 ? new Error('broker upload too large') : null, chunk);
        },
      });
      void pipeline(input.body, limit, outgoing, { signal: input.signal }).catch(() =>
        outgoing.destroy(),
      );
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
  // Each of the redactor's eight percent-decoding rounds can shrink bytes 3:1.
  // Literal-length retention would flush an encoded prefix before the echo is complete.
  const retained =
    Math.max(
      1,
      ...needles.map(({ needle }) => Buffer.byteLength(needle)),
      ...credentials.map(({ value }) => Buffer.byteLength(value) * 3 ** 8),
    ) - 1;
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

const RESPONSE_HEADERS = [
  'content-type',
  'link',
  'retry-after',
  'x-github-request-id',
  'content-disposition',
  'docker-content-digest',
  'docker-distribution-api-version',
] as const;

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
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > 2 * 1024 ** 3 ? new Error('broker response too large') : null, chunk);
    },
  });
  await pipeline(upstream, limit, credentialSafeStream(credentials), response, { signal });
}

/** Follow only broker-originated download redirects. Never return signed URLs to clients. */
export async function brokeredDownload(
  transport: BrokeredHttpStreamTransport,
  initial: Parameters<BrokeredHttpStreamTransport>[0],
  allowed: boolean,
): Promise<IncomingMessage> {
  let input = initial;
  for (let hop = 0; hop <= 5; hop++) {
    const response = await transport(input);
    if (![301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) return response;
    const location = response.headers.location;
    response.destroy();
    if (!allowed || !location || hop === 5) throw new Error('broker redirect rejected');
    const target = new URL(location, `https://${input.hostname}${input.path}`);
    const hostname = target.hostname;
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      (target.port && target.port !== '443') ||
      target.hash ||
      !(
        hostname === 'release-assets.githubusercontent.com' ||
        hostname === 'objects.githubusercontent.com' ||
        hostname === 'pkg-containers.githubusercontent.com' ||
        hostname.endsWith('.actions.githubusercontent.com') ||
        hostname.endsWith('.blob.core.windows.net')
      )
    )
      throw new Error('broker redirect rejected');
    input = {
      ...initial,
      hostname,
      path: target.pathname + target.search,
      headers: { 'user-agent': 'verity-forge-broker', 'accept-encoding': 'identity' },
      body: Buffer.alloc(0),
    };
  }
  throw new Error('broker redirect rejected');
}

/** Related Issue entities can live in other repositories; validate before any bytes escape. */
export async function verifyRelatedIssueResponse(
  upstream: IncomingMessage,
  owner: string,
  repo: string,
): Promise<IncomingMessage> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of upstream) {
    const chunk = Buffer.from(value as Uint8Array);
    bytes += chunk.length;
    if (bytes > 16 * 1024 ** 2) {
      upstream.destroy();
      throw new Error('broker GraphQL response too large');
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const data: unknown = JSON.parse(body.toString('utf8'));
  const expected = `${owner}/${repo}`.toLowerCase();
  const verify = (entity: unknown): void => {
    if (entity === null || entity === undefined) return;
    if (typeof entity !== 'object') throw new Error('broker related issue rejected');
    const item = entity as { repository?: { nameWithOwner?: unknown } };
    if (
      typeof item.repository?.nameWithOwner !== 'string' ||
      item.repository.nameWithOwner.toLowerCase() !== expected
    )
      throw new Error('broker related issue rejected');
  };
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (['subIssues', 'blockedBy', 'blocking'].includes(key) && entry) {
        const connection = entry as { nodes?: unknown[]; edges?: { node: unknown }[] };
        for (const node of connection.nodes ?? []) verify(node);
        for (const edge of connection.edges ?? []) verify(edge.node);
      }
      if (key === 'parent' && entry && typeof entry === 'object' && 'repository' in entry)
        verify(entry);
      walk(entry);
    }
  };
  walk(data);
  return Object.assign(Readable.from([body]), {
    statusCode: upstream.statusCode,
    headers: upstream.headers,
  }) as IncomingMessage;
}
