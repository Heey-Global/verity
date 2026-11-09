import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProtectedBuildClient,
  ProtectedBuildTransportError,
} from './project-egress-build-client.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function fixture(
  reply: (response: ServerResponse, body: string, authorization: string | undefined) => void,
  timeoutMs = 1000,
) {
  const directory = await mkdtemp('/tmp/vpb-');
  cleanup.push(() => rm(directory, { force: true, recursive: true }));
  const socketPath = join(directory, 'host.sock');
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => reply(response, body, request.headers.authorization));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  return createProtectedBuildClient({ socketPath, token: () => 'a'.repeat(64), timeoutMs });
}
const request = {
  projectId: 'project-a',
  attemptId: '11111111-1111-4111-8111-111111111111',
  snapshot: 'attempt-a/verity-build-a',
  image: `verity-devc-repo:${'a'.repeat(12)}`,
  noCache: false,
};
describe('protected host control transport', () => {
  it('authenticates fixed operations and accepts only the matching acknowledgement', async () => {
    const client = await fixture((response, body, authorization) => {
      expect(authorization).toBe(`Bearer ${'a'.repeat(64)}`);
      expect(JSON.parse(body)).toEqual({ operation: 'begin', request });
      response.end(
        JSON.stringify({ version: 1, record: { request, phase: 'running', ended: false } }),
      );
    });
    expect(await client({ operation: 'begin', request })).toMatchObject({ record: { request } });
  });
  it('rejects a changed immutable request even with matching project and attempt', async () => {
    const client = await fixture((response) =>
      response.end(
        JSON.stringify({
          version: 1,
          record: { request: { ...request, noCache: true }, phase: 'running', ended: false },
        }),
      ),
    );
    await expect(client({ operation: 'begin', request })).rejects.toThrow('Changed');
  });
  it('does not treat an HTTP refusal as a retryable lost reply', async () => {
    const client = await fixture((response) => {
      response.statusCode = 403;
      response.end('{}');
    });
    await expect(client({ operation: 'health' })).rejects.toThrow('refused');
  });
  it('settles truncated responses as an unknown transport outcome', async () => {
    const client = await fixture((response) => {
      response.writeHead(200, { 'content-length': '1000' });
      response.write('{');
      setImmediate(() => response.destroy());
    });
    await expect(client({ operation: 'health' })).rejects.toBeInstanceOf(
      ProtectedBuildTransportError,
    );
  });
  it('bounds reply size before parsing it', async () => {
    const client = await fixture((response) => response.end('x'.repeat(32769)));
    await expect(client({ operation: 'health' })).rejects.toThrow('exceeded');
  });
  it('settles a hung host reply at the transport deadline', async () => {
    const client = await fixture((response) => {
      setTimeout(() => response.destroy(), 40);
    }, 10);
    await expect(client({ operation: 'health' })).rejects.toBeInstanceOf(
      ProtectedBuildTransportError,
    );
  });
});

it('preserves only allowlisted refusal details', async () => {
  const correlationId = '22222222-2222-4222-8222-222222222222';
  const client = await fixture((response) => {
    response.statusCode = 409;
    response.end(
      JSON.stringify({
        reason: 'files_prepare_failed',
        correlationId,
        error: 'private daemon output SECRET',
      }),
    );
  });
  await expect(client({ operation: 'health' })).rejects.toThrow(
    `files_prepare_failed; reference ${correlationId}`,
  );
  await expect(client({ operation: 'health' })).rejects.not.toThrow('SECRET');
});
it('never echoes unrecognized refusal reasons or correlation values', async () => {
  const client = await fixture((response) => {
    response.statusCode = 409;
    response.end(JSON.stringify({ reason: 'SECRET', correlationId: '/private/path' }));
  });
  await expect(client({ operation: 'health' })).rejects.toThrow('operation_refused');
  await expect(client({ operation: 'health' })).rejects.not.toThrow('SECRET');
});

it('never confuses slot and health replies, which share the same boolean shape', async () => {
  // A health reply read as a slot answer would release legacy storage reservations.
  const replies = [
    { version: 1, available: true },
    { version: 1, record: { request, phase: 'succeeded', ended: true } },
  ];
  for (const reply of replies) {
    const client = await fixture((response) => response.end(JSON.stringify(reply)));
    await expect(client({ operation: 'slot' })).rejects.toThrow('Mismatched protected build slot');
  }
  const health = await fixture((response) =>
    response.end(JSON.stringify({ version: 1, idle: true })),
  );
  await expect(health({ operation: 'health' })).rejects.toThrow(
    'Mismatched protected builder health',
  );
  const slot = await fixture((response) =>
    response.end(JSON.stringify({ version: 1, idle: true })),
  );
  expect(await slot({ operation: 'slot' })).toEqual({ version: 1, idle: true });
});
