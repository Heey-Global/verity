import { createServer, request, type Server } from 'node:http';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  advanceCutover,
  advanceUpdate,
  beginUpdate,
  type CutoverPhase,
  type UpdateJournal,
} from './update-journal.js';
import { createStandbyExchange, type StandbyExchange } from './standby-directive.js';
import {
  acknowledgeUpdaterStandby,
  readUpdaterStandby,
  startUpdaterStatusServer,
  UpdaterRequestError,
  type UpdaterStatusServer,
} from './updater-status.js';

const image = (character: string): string =>
  `ghcr.io/heey-global/verity/verity-server@sha256:${character.repeat(64)}`;

const CANDIDATE = 'd'.repeat(64);
const PREVIOUS = 'e'.repeat(64);

const servers: UpdaterStatusServer[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

async function fixture(options: { standby?: StandbyExchange } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'verity-updater-standby-'));
  const managedRoot = join(root, 'managed-deployment');
  await mkdir(managedRoot, { mode: 0o700 });
  const socketPath = join(root, 'control', 'updater.sock');
  const token = 'a'.repeat(32);
  const server = await startUpdaterStatusServer({
    socketPath,
    token,
    managedRoot,
    ...(options.standby === undefined ? {} : { standby: options.standby }),
    onOperationAccepted: () => undefined,
  });
  servers.push(server);
  return { socketPath, token, managedRoot, server };
}

/** Drive the journal to the point at which a candidate container exists. */
async function standby(managedRoot: string): Promise<UpdateJournal> {
  await beginUpdate({
    root: managedRoot,
    deploymentId: 'managed-1',
    idempotencyKey: 'k1',
    currentGeneration: 1,
    previousDigest: image('a'),
    targetDigest: image('b'),
  });
  await advanceUpdate(managedRoot, 'requested', 'pulling');
  await advanceUpdate(managedRoot, 'pulling', 'verifying-image');
  await advanceUpdate(managedRoot, 'verifying-image', 'preflight');
  await advanceUpdate(managedRoot, 'preflight', 'creating-standby');
  return advanceUpdate(managedRoot, 'creating-standby', 'standby', {
    candidate: { containerId: CANDIDATE, containerName: 'verity-managed-server-g2' },
  });
}

/** Walk the cutover to `phase` along the journal's own transitions. */
async function cutoverTo(managedRoot: string, phase: CutoverPhase): Promise<void> {
  const path: readonly (readonly [CutoverPhase, CutoverPhase])[] = [
    ['standby', 'quiescing-old'],
    ['quiescing-old', 'handing-off-key'],
    ['handing-off-key', 'activating-candidate'],
    ['activating-candidate', 'checking-candidate'],
    ['checking-candidate', 'draining-gateway'],
    ['draining-gateway', 'switching-gateway'],
    ['switching-gateway', 'observing-candidate'],
    ['observing-candidate', 'committed'],
  ];
  for (const [from, to] of path) {
    await advanceCutover(managedRoot, from, to, { previousContainerId: PREVIOUS });
    if (to === phase) return;
  }
}

/** A raw call, for the cases the typed client cannot express. */
function raw(
  socketPath: string,
  init: {
    readonly method: string;
    readonly token?: string;
    readonly body?: string;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = request(
      {
        socketPath,
        path: '/v1/standby',
        method: init.method,
        headers: init.token === undefined ? {} : { authorization: `Bearer ${init.token}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.end(init.body);
  });
}

/** A boundary that answers one canned response, for the parser's own cases. */
const boundaries: Server[] = [];
afterEach(() => {
  for (const server of boundaries.splice(0)) server.close();
});

async function staticBoundary(body: string, status = 200) {
  const root = await mkdtemp(join(tmpdir(), 'verity-updater-standby-raw-'));
  const socketPath = join(root, 'updater.sock');
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(body);
  });
  boundaries.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath, token: 'a'.repeat(32) };
}

describe('the standby directive over the Updater control boundary', () => {
  /** No operation, nothing to say — which a Server reads as the state it is
   *  already in. */
  it('publishes no directive while no update is under way', async () => {
    const { socketPath, token } = await fixture({ standby: createStandbyExchange() });
    await expect(readUpdaterStandby({ socketPath, token })).resolves.toBeNull();
  });

  it('derives the directive from the journal phase', async () => {
    const exchange = createStandbyExchange();
    const { socketPath, token, managedRoot } = await fixture({ standby: exchange });
    await standby(managedRoot);

    await expect(readUpdaterStandby({ socketPath, token })).resolves.toEqual({
      directive: 'serving',
      operationId: 'generation-2',
      acknowledged: null,
    });

    await cutoverTo(managedRoot, 'activating-candidate');
    await expect(readUpdaterStandby({ socketPath, token })).resolves.toMatchObject({
      directive: 'quiesced',
    });
  });

  /** The drain only means something while the old Server is still listening, so
   *  the phase that precedes it must not quiesce anything by itself. */
  it('keeps the old Server serving through the drain until the cutover asks', async () => {
    const exchange = createStandbyExchange();
    const { socketPath, token, managedRoot } = await fixture({ standby: exchange });
    await standby(managedRoot);
    await cutoverTo(managedRoot, 'quiescing-old');

    await expect(readUpdaterStandby({ socketPath, token })).resolves.toMatchObject({
      directive: 'serving',
    });

    exchange.request('generation-2', 'quiesced');
    await expect(readUpdaterStandby({ socketPath, token })).resolves.toMatchObject({
      directive: 'quiesced',
    });
  });

  /** The cutover reads the answer out of the same exchange the boundary writes
   *  it into; that shared object is the whole channel. */
  it('records an acknowledgement the cutover can then read', async () => {
    const exchange = createStandbyExchange();
    const { socketPath, token, managedRoot } = await fixture({ standby: exchange });
    await standby(managedRoot);
    await cutoverTo(managedRoot, 'handing-off-key');

    await expect(
      acknowledgeUpdaterStandby({
        socketPath,
        token,
        operationId: 'generation-2',
        state: 'quiesced',
      }),
    ).resolves.toBe(true);

    expect(exchange.acknowledged('generation-2')).toBe('quiesced');
    await expect(readUpdaterStandby({ socketPath, token })).resolves.toMatchObject({
      acknowledged: 'quiesced',
    });
  });

  /**
   * A Server answering for an operation the journal is not on describes a state
   * this cutover has no use for. Refusing it rather than storing it keeps the
   * cutover's wait honest — it waits for the standby of THIS update, or falls
   * back to stopping the container.
   */
  it('refuses an acknowledgement for another operation', async () => {
    const exchange = createStandbyExchange();
    const { socketPath, token, managedRoot } = await fixture({ standby: exchange });
    await standby(managedRoot);
    await cutoverTo(managedRoot, 'handing-off-key');

    await expect(
      acknowledgeUpdaterStandby({
        socketPath,
        token,
        operationId: 'generation-7',
        state: 'quiesced',
      }),
    ).resolves.toBe(false);

    expect(exchange.acknowledged('generation-7')).toBeNull();
    expect(exchange.acknowledged('generation-2')).toBeNull();
  });

  it('refuses an acknowledgement when no operation is under way at all', async () => {
    const { socketPath, token } = await fixture({ standby: createStandbyExchange() });
    await expect(
      acknowledgeUpdaterStandby({
        socketPath,
        token,
        operationId: 'generation-2',
        state: 'quiesced',
      }),
    ).resolves.toBe(false);
  });

  /**
   * An Updater with nowhere to keep the answer still publishes the directive —
   * a Server may quiesce on it — but the cutover has no way to learn that it
   * did, so the honest answer to the Server is that nothing was recorded.
   */
  it('still publishes a directive without an exchange, and records nothing', async () => {
    const { socketPath, token, managedRoot } = await fixture();
    await standby(managedRoot);
    await cutoverTo(managedRoot, 'activating-candidate');

    await expect(readUpdaterStandby({ socketPath, token })).resolves.toEqual({
      directive: 'quiesced',
      operationId: 'generation-2',
      acknowledged: null,
    });
    await expect(
      acknowledgeUpdaterStandby({
        socketPath,
        token,
        operationId: 'generation-2',
        state: 'quiesced',
      }),
    ).resolves.toBe(false);
  });

  it('rejects a malformed acknowledgement', async () => {
    const { socketPath, token, managedRoot } = await fixture({ standby: createStandbyExchange() });
    await standby(managedRoot);
    for (const body of [
      '',
      'not json',
      '[]',
      '{"operationId":"generation-2"}',
      '{"operationId":"generation-2","state":"paused"}',
      '{"operationId":"../etc","state":"quiesced"}',
      '{"state":"quiesced"}',
    ])
      expect((await raw(socketPath, { method: 'POST', token, body })).status).toBe(400);
  });

  it('answers an unauthenticated caller before it looks at anything', async () => {
    const { socketPath, managedRoot } = await fixture({ standby: createStandbyExchange() });
    await standby(managedRoot);
    expect((await raw(socketPath, { method: 'GET' })).status).toBe(401);
    expect((await raw(socketPath, { method: 'GET', token: 'b'.repeat(32) })).status).toBe(401);
  });

  it('serves no other method on the route', async () => {
    const { socketPath, token } = await fixture({ standby: createStandbyExchange() });
    expect((await raw(socketPath, { method: 'DELETE', token })).status).toBe(404);
  });

  /** An acknowledgement describes a process that is running right now; it may
   *  not outlive the boundary that collected it. */
  it('forgets the exchange when the boundary closes', async () => {
    const exchange = createStandbyExchange();
    const { socketPath, token, managedRoot, server } = await fixture({ standby: exchange });
    await standby(managedRoot);
    await cutoverTo(managedRoot, 'handing-off-key');
    await acknowledgeUpdaterStandby({
      socketPath,
      token,
      operationId: 'generation-2',
      state: 'quiesced',
    });

    await servers.splice(servers.indexOf(server), 1)[0]!.close();

    expect(exchange.acknowledged('generation-2')).toBeNull();
    await expect(readUpdaterStandby({ socketPath, token })).rejects.toThrow();
  });

  /** A directive is acted on by closing every listener a Server has. Anything
   *  this client cannot read exactly is not one. */
  it('refuses to interpret a response that is not exactly a directive', async () => {
    const directive = '"directive":"quiesced","operationId":"generation-2"';
    for (const body of [
      '{}',
      '{"standby":{}}',
      `{"standby":{${directive}}}`,
      `{"standby":{${directive},"acknowledged":null},"extra":1}`,
      `{"standby":{${directive},"acknowledged":null,"extra":1}}`,
      `{"standby":{${directive},"acknowledged":"paused"}}`,
      '{"standby":{"directive":"paused","operationId":"generation-2","acknowledged":null}}',
    ]) {
      const { socketPath, token } = await staticBoundary(body);
      await expect(readUpdaterStandby({ socketPath, token })).rejects.toThrow(
        'updater standby response is invalid',
      );
    }
  });

  /** A boundary that answered with something other than 200 has not published a
   *  directive, whatever it put in the body. */
  it('refuses a directive the boundary did not answer 200 for', async () => {
    const { socketPath, token } = await staticBoundary('{"standby":null}', 503);
    await expect(readUpdaterStandby({ socketPath, token })).rejects.toBeInstanceOf(
      UpdaterRequestError,
    );
  });
});
