import { request } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  advanceCompanionReconciliation,
  advanceCutover,
  advanceUpdate,
  archiveUpdateJournal,
  beginUpdate,
  type UpdateJournal,
} from './update-journal.js';
import {
  createKeyHandoffReceiver,
  createKeyHandoffSenderIdentity,
  sealUnlockedKey,
  type KeyHandoffBinding,
} from './secret-key-handoff.js';
import {
  claimUpdaterHandoffEnvelope,
  publishUpdaterHandoff,
  readUpdaterHandoff,
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'verity-updater-handoff-'));
  const managedRoot = join(root, 'managed-deployment');
  await mkdir(managedRoot, { mode: 0o700 });
  const socketPath = join(root, 'control', 'updater.sock');
  const token = 'a'.repeat(32);
  const server = await startUpdaterStatusServer({
    socketPath,
    token,
    managedRoot,
    onOperationAccepted: () => undefined,
  });
  servers.push(server);
  return { socketPath, token, managedRoot };
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

/** Drive a prepared operation all the way to `committed`. */
async function commit(managedRoot: string): Promise<void> {
  for (const [from, to] of [
    ['standby', 'quiescing-old'],
    ['quiescing-old', 'handing-off-key'],
    ['handing-off-key', 'activating-candidate'],
    ['activating-candidate', 'checking-candidate'],
    ['checking-candidate', 'draining-gateway'],
    ['draining-gateway', 'switching-gateway'],
    ['switching-gateway', 'observing-candidate'],
    ['observing-candidate', 'committed'],
  ] as const) {
    await advanceCutover(managedRoot, from, to, { previousContainerId: PREVIOUS });
  }
}

/** A raw call, for the cases the typed client cannot express. */
function raw(
  socketPath: string,
  init: {
    readonly method: string;
    readonly path: string;
    readonly token?: string;
    readonly body?: string;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = request(
      {
        socketPath,
        path: init.path,
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
    // A body the server refuses mid-stream is answered by hanging up, which the
    // client sees as a reset rather than as a status. Reported as 0 so a test
    // can tell "refused" from "answered" without the call itself throwing.
    req.once('error', () => resolve({ status: 0, body: '' }));
    req.end(init.body);
  });
}

/** A raw call whose body is held back until the test decides to send it. */
function rawStreaming(
  socketPath: string,
  init: {
    readonly method: string;
    readonly path: string;
    readonly token: string;
    readonly body: string;
  },
): { finish: () => Promise<{ status: number; body: string }> } {
  let settle: (result: { status: number; body: string }) => void = () => undefined;
  const answered = new Promise<{ status: number; body: string }>((resolve) => {
    settle = resolve;
  });
  const req = request(
    {
      socketPath,
      path: init.path,
      method: init.method,
      headers: {
        authorization: `Bearer ${init.token}`,
        'content-length': String(Buffer.byteLength(init.body)),
      },
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        settle({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
    },
  );
  req.once('error', () => settle({ status: 0, body: '' }));
  req.flushHeaders();
  return {
    finish: () => {
      req.end(init.body);
      return answered;
    },
  };
}

describe('managed Updater secret-key handoff relay', () => {
  it('relays nothing while no candidate exists', async () => {
    const { socketPath, token, managedRoot } = await fixture();
    expect(await readUpdaterHandoff({ socketPath, token })).toBeNull();

    await beginUpdate({
      root: managedRoot,
      deploymentId: 'managed-1',
      idempotencyKey: 'k1',
      currentGeneration: 1,
      previousDigest: image('a'),
      targetDigest: image('b'),
    });
    // Journalled intent is not a candidate: nothing has been created to hand a
    // key to until the standby container exists.
    expect(await readUpdaterHandoff({ socketPath, token })).toBeNull();
  });

  it('publishes the binding it derived from its own journal', async () => {
    const { socketPath, token, managedRoot } = await fixture();
    const journal = await standby(managedRoot);

    const handoff = await readUpdaterHandoff({ socketPath, token });
    expect(handoff).toEqual({
      binding: {
        operationId: `generation-${String(journal.generation)}`,
        targetDigest: image('b'),
        containerId: CANDIDATE,
      },
    });
  });

  it('carries a sealed key from the outgoing to the promoted Server', async () => {
    const { socketPath, token, managedRoot } = await fixture();
    await standby(managedRoot);
    const call = { socketPath, token };

    // Outgoing Server: announce the identity the promoted one must require.
    const sender = createKeyHandoffSenderIdentity();
    expect(await publishUpdaterHandoff(call, { senderIdentityPublicKey: sender.publicKey })).toBe(
      true,
    );

    // Promoted Server: read that identity and offer an ephemeral key to it.
    const announced = await readUpdaterHandoff(call);
    expect(announced?.senderIdentityPublicKey).toBe(sender.publicKey);
    const receiver = createKeyHandoffReceiver(
      announced!.binding,
      announced!.senderIdentityPublicKey!,
    );
    expect(await publishUpdaterHandoff(call, { offer: receiver.offer })).toBe(true);

    // Outgoing Server: seal the unlocked key to that offer.
    const seen = await readUpdaterHandoff(call);
    expect(seen?.offer).toEqual(receiver.offer);
    const envelope = sealUnlockedKey(Buffer.from('unlocked-data-key'), seen!.offer!, sender);
    expect(await publishUpdaterHandoff(call, { envelope })).toBe(true);

    // Promoted Server: claim it — and again, because a fetch that consumed the
    // envelope would let any holder of this socket's token (both Servers have
    // it) leave the successor sealed just by asking first.
    const claimed = await claimUpdaterHandoffEnvelope(call);
    expect(claimed).toEqual(envelope);
    expect(await claimUpdaterHandoffEnvelope(call)).toEqual(envelope);

    receiver.accept(claimed!);
    await receiver.use(async (key) => {
      expect(key.toString()).toBe('unlocked-data-key');
    });
  });

  it('declines material that does not belong to the running candidate', async () => {
    const { socketPath, token, managedRoot } = await fixture();
    await standby(managedRoot);
    const call = { socketPath, token };

    const sender = createKeyHandoffSenderIdentity();
    const elsewhere: KeyHandoffBinding = {
      operationId: 'generation-2',
      targetDigest: image('b'),
      containerId: 'f'.repeat(64),
    };
    const receiver = createKeyHandoffReceiver(elsewhere, sender.publicKey);
    expect(await publishUpdaterHandoff(call, { offer: receiver.offer })).toBe(false);
    expect(await readUpdaterHandoff(call)).toEqual({
      binding: {
        operationId: 'generation-2',
        targetDigest: image('b'),
        containerId: CANDIDATE,
      },
    });
  });

  it('drops the relay once the operation can no longer use it', async () => {
    const { socketPath, token, managedRoot } = await fixture();
    await standby(managedRoot);
    const call = { socketPath, token };

    const sender = createKeyHandoffSenderIdentity();
    await publishUpdaterHandoff(call, { senderIdentityPublicKey: sender.publicKey });
    const announced = await readUpdaterHandoff(call);
    const receiver = createKeyHandoffReceiver(announced!.binding, sender.publicKey);
    await publishUpdaterHandoff(call, { offer: receiver.offer });
    await publishUpdaterHandoff(call, {
      envelope: sealUnlockedKey(Buffer.from('unlocked-data-key'), receiver.offer, sender),
    });

    for (const [from, to] of [
      ['standby', 'quiescing-old'],
      ['quiescing-old', 'handing-off-key'],
      ['handing-off-key', 'activating-candidate'],
      ['activating-candidate', 'checking-candidate'],
      ['checking-candidate', 'draining-gateway'],
      ['draining-gateway', 'switching-gateway'],
      ['switching-gateway', 'observing-candidate'],
      ['observing-candidate', 'committed'],
    ] as const) {
      await advanceCutover(managedRoot, from, to, { previousContainerId: PREVIOUS });
    }

    expect(await readUpdaterHandoff(call)).toBeNull();
    expect(await claimUpdaterHandoffEnvelope(call)).toBeNull();
    expect(await publishUpdaterHandoff(call, { senderIdentityPublicKey: sender.publicKey })).toBe(
      false,
    );
  });

  /**
   * The binding a publication is checked against has to be the journal's at the
   * moment it is applied, not at the moment the request arrived. Reading a body
   * takes as long as the peer takes to send it, and an operation can end inside
   * that window — a message admitted against the operation that has since gone
   * would point the mailbox back at it and take the current one's state with it.
   */
  it('does not let a slow publication reach the operation it was meant for', async () => {
    const { socketPath, token, managedRoot } = await fixture();
    await standby(managedRoot);
    const call = { socketPath, token };

    const stale = createKeyHandoffSenderIdentity();
    await publishUpdaterHandoff(call, { senderIdentityPublicKey: stale.publicKey });
    const staleOffer = createKeyHandoffReceiver(
      (await readUpdaterHandoff(call))!.binding,
      stale.publicKey,
    ).offer;

    // Sent header-first, so the operation it addresses can end before the body
    // that addresses it has been read.
    const slow = rawStreaming(socketPath, {
      method: 'POST',
      path: '/v1/handoff',
      token,
      body: JSON.stringify({ offer: staleOffer }),
    });

    for (const [from, to] of [
      ['standby', 'quiescing-old'],
      ['quiescing-old', 'handing-off-key'],
      ['handing-off-key', 'activating-candidate'],
      ['activating-candidate', 'checking-candidate'],
      ['checking-candidate', 'draining-gateway'],
      ['draining-gateway', 'switching-gateway'],
      ['switching-gateway', 'observing-candidate'],
      ['observing-candidate', 'committed'],
    ] as const) {
      await advanceCutover(managedRoot, from, to, { previousContainerId: PREVIOUS });
    }
    // The finished operation frees the single-slot journal for its successor.
    await advanceCompanionReconciliation(managedRoot, 'committed', 'reconciling-companions');
    await advanceCompanionReconciliation(managedRoot, 'reconciling-companions', 'completed');
    await archiveUpdateJournal(managedRoot);
    await beginUpdate({
      root: managedRoot,
      deploymentId: 'managed-1',
      idempotencyKey: 'k2',
      currentGeneration: 2,
      previousDigest: image('b'),
      targetDigest: image('c'),
    });
    for (const [from, to] of [
      ['requested', 'pulling'],
      ['pulling', 'verifying-image'],
      ['verifying-image', 'preflight'],
      ['preflight', 'creating-standby'],
    ] as const) {
      await advanceUpdate(managedRoot, from, to);
    }
    await advanceUpdate(managedRoot, 'creating-standby', 'standby', {
      candidate: { containerId: 'f'.repeat(64), containerName: 'verity-managed-server-g3' },
    });

    // The successor's handoff, under way while the stale body is still in flight.
    const current = createKeyHandoffSenderIdentity();
    expect(await publishUpdaterHandoff(call, { senderIdentityPublicKey: current.publicKey })).toBe(
      true,
    );

    expect((await slow.finish()).status).toBe(409);
    // Untouched: neither adopted into this operation nor able to clear it.
    const held = await readUpdaterHandoff(call);
    expect(held?.senderIdentityPublicKey).toBe(current.publicKey);
    expect(held?.offer).toBeUndefined();
  });

  /**
   * Two handoff requests can resolve in the opposite order to the journal states
   * they read, and the older one describes a deployment that has been left
   * behind. Acting on it would discard the mailbox of the operation that
   * replaced it. Reproduced by putting the journal back where the slower read
   * would have found it, which is the state such a request arrives with.
   */
  it('refuses a journal state that has already been superseded', async () => {
    const { socketPath, token, managedRoot } = await fixture();
    await standby(managedRoot);
    const call = { socketPath, token };

    await commit(managedRoot);
    await advanceCompanionReconciliation(managedRoot, 'committed', 'reconciling-companions');
    await advanceCompanionReconciliation(managedRoot, 'reconciling-companions', 'completed');
    await archiveUpdateJournal(managedRoot);
    await beginUpdate({
      root: managedRoot,
      deploymentId: 'managed-1',
      idempotencyKey: 'k2',
      currentGeneration: 2,
      previousDigest: image('b'),
      targetDigest: image('c'),
    });
    for (const [from, to] of [
      ['requested', 'pulling'],
      ['pulling', 'verifying-image'],
      ['verifying-image', 'preflight'],
      ['preflight', 'creating-standby'],
    ] as const) {
      await advanceUpdate(managedRoot, from, to);
    }
    await advanceUpdate(managedRoot, 'creating-standby', 'standby', {
      candidate: { containerId: 'f'.repeat(64), containerName: 'verity-managed-server-g3' },
    });

    const sender = createKeyHandoffSenderIdentity();
    expect(await publishUpdaterHandoff(call, { senderIdentityPublicKey: sender.publicKey })).toBe(
      true,
    );

    const live = join(managedRoot, 'update-journal.json');
    const current = await readFile(live);
    await copyFile(join(managedRoot, 'update-journal-g2.json'), live);
    expect((await raw(socketPath, { method: 'GET', path: '/v1/handoff', token })).status).toBe(503);
    expect(
      (
        await raw(socketPath, {
          method: 'POST',
          path: '/v1/handoff',
          token,
          body: JSON.stringify({
            senderIdentityPublicKey: createKeyHandoffSenderIdentity().publicKey,
          }),
        })
      ).status,
    ).toBe(503);

    // Nothing the superseded state carried reached the operation that is running.
    await writeFile(live, current);
    expect((await readUpdaterHandoff(call))?.senderIdentityPublicKey).toBe(sender.publicKey);
  });

  it('refuses a state its own generation has already moved past', async () => {
    const { socketPath, token, managedRoot } = await fixture();
    await standby(managedRoot);
    const call = { socketPath, token };

    const sender = createKeyHandoffSenderIdentity();
    expect(await publishUpdaterHandoff(call, { senderIdentityPublicKey: sender.publicKey })).toBe(
      true,
    );

    // Same operation, finished: whoever gets there first clears the mailbox.
    const live = join(managedRoot, 'update-journal.json');
    const open = await readFile(live);
    await commit(managedRoot);
    expect(await readUpdaterHandoff(call)).toBeNull();

    // A request that read the operation while it was still open must not put
    // that state back on its way out. Its generation is the current one, so
    // only the stage within it says that what it holds has been left behind.
    await writeFile(live, open);
    expect((await raw(socketPath, { method: 'GET', path: '/v1/handoff', token })).status).toBe(503);
    expect(
      (
        await raw(socketPath, {
          method: 'POST',
          path: '/v1/handoff',
          token,
          body: JSON.stringify({ senderIdentityPublicKey: sender.publicKey }),
        })
      ).status,
    ).toBe(503);
  });

  it('is reachable only with the Updater bearer token', async () => {
    const { socketPath, token, managedRoot } = await fixture();
    await standby(managedRoot);

    for (const path of ['/v1/handoff', '/v1/handoff/envelope']) {
      expect((await raw(socketPath, { method: 'POST', path })).status).toBe(401);
      expect((await raw(socketPath, { method: 'POST', path, token: 'b'.repeat(32) })).status).toBe(
        401,
      );
    }
    expect((await raw(socketPath, { method: 'GET', path: '/v1/handoff' })).status).toBe(401);
    // Only the two verbs the relay needs; nothing else answers on the prefix.
    expect(
      (await raw(socketPath, { method: 'GET', path: '/v1/handoff/envelope', token })).status,
    ).toBe(404);
    expect((await raw(socketPath, { method: 'DELETE', path: '/v1/handoff', token })).status).toBe(
      404,
    );
  });

  it('refuses a body that is not exactly one handoff message', async () => {
    const { socketPath, token, managedRoot } = await fixture();
    await standby(managedRoot);
    const post = async (body: string) =>
      (await raw(socketPath, { method: 'POST', path: '/v1/handoff', token, body })).status;

    expect(await post('not json')).toBe(400);
    expect(await post(JSON.stringify({}))).toBe(400);
    expect(await post(JSON.stringify({ offer: {}, envelope: {} }))).toBe(400);
    expect(await post(JSON.stringify({ unexpected: 'field' }))).toBe(400);
    // A message wide enough to carry the largest sealed key is still read in
    // full — 409 is the mailbox refusing its contents, not the body being cut.
    expect(await post(JSON.stringify({ offer: 'x'.repeat(10_000) }))).toBe(409);
    // Past the bound it is refused without the contents being examined at all.
    expect([0, 400]).toContain(await post(JSON.stringify({ offer: 'x'.repeat(20_000) })));
    expect(await readUpdaterHandoff({ socketPath, token })).toEqual({
      binding: {
        operationId: 'generation-2',
        targetDigest: image('b'),
        containerId: CANDIDATE,
      },
    });
  });

  it('surfaces a rejected claim as an updater error', async () => {
    const { socketPath } = await fixture();
    await expect(
      claimUpdaterHandoffEnvelope({ socketPath, token: 'b'.repeat(32) }),
    ).rejects.toBeInstanceOf(UpdaterRequestError);
  });
});
