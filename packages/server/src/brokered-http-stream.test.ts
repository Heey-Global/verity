import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
  brokeredDownload,
  verifyRelatedIssueResponse,
  type BrokeredHttpStreamTransport,
  credentialSafeStream,
} from './brokered-http-stream.js';

async function read(chunks: Buffer[], credential: string): Promise<Buffer> {
  const output: Buffer[] = [];
  const stream = Readable.from(chunks).pipe(
    credentialSafeStream([{ value: credential, alias: 'TEST' }]),
  );
  for await (const chunk of stream) output.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(output);
}

describe('credential-safe binary response stream', () => {
  it('rejects raw and encoded echoes at every chunk boundary before flushing credential bytes', async () => {
    const token = 'ghs_server_only_stream_fixture';
    for (const value of [
      token,
      [...Buffer.from(token)].map((byte) => `%${byte.toString(16)}`).join(''),
      [...Buffer.from(token)].map((byte) => `%25${byte.toString(16)}`).join(''),
      Buffer.from(token).toString('base64'),
      Buffer.from(token).toString('base64url'),
    ]) {
      for (let split = 1; split < value.length; split++) {
        await expect(
          read(
            [Buffer.from(`safe-prefix${value.slice(0, split)}`), Buffer.from(value.slice(split))],
            token,
          ),
        ).rejects.toThrow('broker response withheld');
      }
    }
  });
  it('withholds echoes through all eight supported percent-decoding rounds', async () => {
    const token = 'ghs_nested_fixture';
    let encoded = token;
    for (let round = 0; round < 8; round++) {
      encoded = [...Buffer.from(encoded)].map((byte) => `%${byte.toString(16)}`).join('');
    }
    const split = encoded.length - 1;
    await expect(
      read([Buffer.from(encoded.slice(0, split)), Buffer.from(encoded.slice(split))], token),
    ).rejects.toThrow('broker response withheld');
  });
  it('preserves binary data and final bytes when no credential is present', async () => {
    const chunks = [Buffer.from([0, 255, 129, 1]), Buffer.from('pack-body'), Buffer.from([255, 0])];
    expect(await read(chunks, 'credential-that-is-not-present')).toEqual(Buffer.concat(chunks));
  });
});

describe('broker-managed downloads and related entities', () => {
  it('strips credentials on every redirect and never requests a disallowed host', async () => {
    const calls: Array<Parameters<BrokeredHttpStreamTransport>[0]> = [];
    const transport: BrokeredHttpStreamTransport = async (input) => {
      calls.push(input);
      return Object.assign(Readable.from(['body']), {
        statusCode: calls.length === 1 ? 302 : 200,
        headers:
          calls.length === 1
            ? { location: 'https://objects.githubusercontent.com/object?signed=private' }
            : {},
      }) as IncomingMessage;
    };
    const input = {
      hostname: 'api.github.com',
      path: '/repos/acme/app/releases/assets/1',
      method: 'GET',
      headers: { authorization: 'Bearer secret' },
      body: Buffer.alloc(0),
      signal: AbortSignal.timeout(1000),
    };
    await brokeredDownload(transport, input, true);
    expect(calls[1]?.headers).not.toHaveProperty('authorization');
    expect(calls[1]?.hostname).toBe('objects.githubusercontent.com');
    for (const location of [
      'https://evil.example/blob',
      'http://objects.githubusercontent.com/blob',
      'https://user:pass@objects.githubusercontent.com/blob',
      'https://objects.githubusercontent.com:444/blob',
      'https://api.github.com/repos/foreign/app/releases/assets/1',
    ]) {
      let count = 0;
      const redirected: BrokeredHttpStreamTransport = async () => {
        count++;
        return Object.assign(Readable.from([]), {
          statusCode: 302,
          headers: { location },
        }) as IncomingMessage;
      };
      await expect(brokeredDownload(redirected, input, true)).rejects.toThrow();
      expect(count).toBe(1);
    }
  });
  it('rejects redirect loops at the broker', async () => {
    let count = 0;
    const transport: BrokeredHttpStreamTransport = async () => {
      count++;
      return Object.assign(Readable.from([]), {
        statusCode: 302,
        headers: { location: 'https://objects.githubusercontent.com/loop' },
      }) as IncomingMessage;
    };
    await expect(
      brokeredDownload(
        transport,
        {
          hostname: 'api.github.com',
          path: '/download',
          method: 'GET',
          headers: {},
          body: Buffer.alloc(0),
          signal: AbortSignal.timeout(1000),
        },
        true,
      ),
    ).rejects.toThrow();
    expect(count).toBe(6);
  });
  it('validates the returned repository of related issues before emitting any response bytes', async () => {
    for (const repository of ['acme/app', 'other/repo']) {
      const upstream = Object.assign(
        Readable.from([
          JSON.stringify({
            data: {
              repository: {
                issue: {
                  blockedBy: {
                    nodes: [{ id: 'issue', repository: { nameWithOwner: repository } }],
                  },
                },
              },
            },
          }),
        ]),
        { statusCode: 200, headers: {} },
      ) as IncomingMessage;
      if (repository === 'acme/app')
        await expect(verifyRelatedIssueResponse(upstream, 'acme', 'app')).resolves.toBeDefined();
      else
        await expect(verifyRelatedIssueResponse(upstream, 'acme', 'app')).rejects.toThrow(
          'broker related issue rejected',
        );
    }
  });
});
