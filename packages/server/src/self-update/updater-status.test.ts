import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sealDeploymentSpec, type ServerDeploymentSpecBody } from './deployment-spec.js';
import { initializeManagedDeployment } from './managed-deployment.js';
import {
  createKeyHandoffReceiver,
  createKeyHandoffSenderIdentity,
  sealUnlockedKey,
} from './secret-key-handoff.js';
import {
  advanceUpdate,
  archiveUpdateJournal,
  failUpdate,
  readUpdateJournal,
  type UpdateJournal,
} from './update-journal.js';
import {
  acknowledgeUpdaterStandby,
  claimUpdaterHandoffEnvelope,
  publishUpdaterHandoff,
  readUpdaterAgentSeed,
  readUpdaterDeployment,
  readUpdaterHandoff,
  readUpdaterOperation,
  readUpdaterPostgres,
  readUpdaterStandby,
  requestUpdaterOperation,
  publishControlToken,
  startUpdaterStatusServer,
  updaterControlTokenPath,
  UpdaterRequestError,
  type UpdaterErrorCode,
  type UpdaterStatusServer,
} from './updater-status.js';

const image = (character: string): string =>
  `ghcr.io/heey-global/verity/verity-server@sha256:${character.repeat(64)}`;

const adoptionSpec = (): Omit<ServerDeploymentSpecBody, 'schemaVersion' | 'deploymentId'> => ({
  image: image('a'),
  environment: [{ name: 'DATABASE_URL', source: { kind: 'env', name: 'DATABASE_URL' } }],
  mounts: [
    { source: { kind: 'volume', name: 'verity-data' }, target: '/srv/verity', readOnly: false },
    {
      source: { kind: 'volume', name: 'verity-agent-gateway-control' },
      target: '/run/verity-agent-gateway',
      readOnly: false,
    },
    {
      source: { kind: 'bind', path: '/var/run/docker.sock' },
      target: '/var/run/docker.sock',
      readOnly: false,
    },
  ],
  user: { uid: 1000, gid: 1000, supplementaryGids: [1101] },
  restart: 'unless-stopped',
  network: 'verity-net',
  platform: { os: 'linux', architecture: 'amd64' },
  security: { noNewPrivileges: true, readOnlyRootFilesystem: false, capAdd: ['CHOWN'] },
});

const servers: UpdaterStatusServer[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

async function fixture(
  options: {
    managed?: boolean;
    onOperationAccepted?: (journal: UpdateJournal) => void | Promise<void>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'verity-updater-status-'));
  const managedRoot = join(root, 'managed-deployment');
  await mkdir(managedRoot, { mode: 0o700 });
  await chmod(managedRoot, 0o700);
  if (options.managed === true) {
    await initializeManagedDeployment({
      root: managedRoot,
      deploymentId: 'managed-1',
      spec: adoptionSpec(),
    });
  }
  const socketPath = join(root, 'control', 'updater.sock');
  const token = 'a'.repeat(32);
  const accepted: UpdateJournal[] = [];
  const server = await startUpdaterStatusServer({
    socketPath,
    token,
    managedRoot,
    onOperationAccepted:
      options.onOperationAccepted ??
      ((journal) => {
        accepted.push(journal);
      }),
  });
  servers.push(server);
  return { socketPath, token, managedRoot, accepted };
}

describe('managed Updater status boundary', () => {
  it('keeps a post-202 callback rejection contained and the boundary available', async () => {
    const call = await fixture({
      managed: true,
      onOperationAccepted: async () => Promise.reject(new Error('injected callback failure')),
    });
    await expect(
      requestUpdaterOperation({
        socketPath: call.socketPath,
        token: call.token,
        idempotencyKey: 'callback-rejection',
        targetDigest: image('b'),
      }),
    ).resolves.toMatchObject({ targetDigest: image('b') });
    await new Promise((resolve) => setImmediate(resolve));
    await expect(readUpdaterOperation(call)).resolves.toMatchObject({ targetDigest: image('b') });
  });

  it('reports missing authority as explicitly unmanaged over a private socket', async () => {
    const { socketPath, token } = await fixture();
    await expect(readUpdaterDeployment({ socketPath, token })).resolves.toEqual({
      managed: false,
      reason: 'managed deployment has not been initialized',
    });
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
  });

  it('rejects an invalid bearer token without exposing authority details', async () => {
    const { socketPath } = await fixture();
    await expect(readUpdaterDeployment({ socketPath, token: 'b'.repeat(32) })).rejects.toThrow(
      'HTTP 401',
    );
  });

  it('keeps the socket and the token private when no peer group is configured', async () => {
    const { socketPath } = await fixture();
    expect((await stat(join(socketPath, '..'))).mode & 0o777).toBe(0o700);
    await expect(stat(updaterControlTokenPath(socketPath))).rejects.toThrow(/ENOENT/);
  });

  it('publishes the socket and the token to the configured peer group', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-updater-status-'));
    const managedRoot = join(root, 'managed-deployment');
    await mkdir(managedRoot, { mode: 0o700 });
    const socketPath = join(root, 'control', 'updater.sock');
    const token = 'c'.repeat(32);
    const server = await startUpdaterStatusServer({
      socketPath,
      token,
      managedRoot,
      // The Updater runs as root in production and can name any group; the test
      // process can only chown to a group it belongs to.
      peerGid: process.getgid?.() ?? 0,
      onOperationAccepted: () => undefined,
    });
    servers.push(server);
    const tokenPath = updaterControlTokenPath(socketPath);
    // Group may read and use both, and may replace neither: the directory is
    // not group-writable.
    expect((await stat(join(root, 'control'))).mode & 0o777).toBe(0o750);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o660);
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o640);
    expect(await readFile(tokenPath, 'utf8')).toBe(token);
    // The published token is the one the boundary actually accepts.
    await expect(readUpdaterDeployment({ socketPath, token })).resolves.toMatchObject({
      managed: false,
    });
    await servers.splice(servers.indexOf(server), 1)[0]!.close();
    await expect(stat(tokenPath)).rejects.toThrow(/ENOENT/);
  });

  it('does not remove a successor socket or token when an old instance closes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-updater-successor-'));
    const managedRoot = join(root, 'managed-deployment');
    await mkdir(managedRoot, { mode: 0o700 });
    const socketPath = join(root, 'control', 'updater.sock');
    const tokenPath = updaterControlTokenPath(socketPath);
    const old = await startUpdaterStatusServer({
      socketPath,
      token: 'o'.repeat(32),
      managedRoot,
      peerGid: process.getgid?.() ?? 0,
    });
    await unlink(socketPath);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const successor = createHttpServer();
    await new Promise<void>((resolve, reject) => {
      successor.once('error', reject);
      successor.listen(socketPath, resolve);
    });
    await unlink(tokenPath);
    await writeFile(tokenPath, 'successor-token', { mode: 0o640 });

    await old.close();
    expect((await lstat(socketPath)).isSocket()).toBe(true);
    expect(await readFile(tokenPath, 'utf8')).toBe('successor-token');

    await new Promise<void>((resolve, reject) =>
      successor.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    await unlink(socketPath).catch(() => undefined);
    await unlink(tokenPath).catch(() => undefined);
  });

  /**
   * Startup clears the previous token before binding, and it does so by path.
   * If that name resolves to something the Updater did not publish — a
   * directory, a mount someone attached to the control directory — deleting it
   * is not cleanup, it is destroying state on the operator's behalf. The check
   * is on the entry rather than on the directory because the directory is only
   * verified once, at startup, and the entries inside it outlive that check.
   */
  it('refuses to clear a control token it did not publish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-updater-status-'));
    const socketPath = join(root, 'control', 'updater.sock');
    const tokenPath = updaterControlTokenPath(socketPath);
    await mkdir(join(root, 'control'), { recursive: true, mode: 0o700 });
    await symlink(join(root, 'elsewhere'), tokenPath);
    await expect(
      startUpdaterStatusServer({
        socketPath,
        token: 'd'.repeat(32),
        managedRoot: join(root, 'managed-deployment'),
      }),
    ).rejects.toThrow(/not a regular file/);
    // Refused, not quietly unlinked: the entry is still there to be looked at.
    expect((await lstat(tokenPath)).isSymbolicLink()).toBe(true);
  });

  /**
   * The socket is bound before the token is published, so a refusal at that
   * point happens with a listener already accepting requests. Leaving it up
   * would hand out an authorized boundary to a caller who was told startup
   * failed — and leave a socket behind that fails the next start's ownership
   * check.
   */
  it('takes the listener down when publishing the token fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-updater-status-'));
    const socketPath = join(root, 'control', 'updater.sock');
    await mkdir(join(root, 'control'), { recursive: true, mode: 0o700 });
    await symlink(join(root, 'elsewhere'), `${updaterControlTokenPath(socketPath)}.tmp`);
    await expect(
      startUpdaterStatusServer({
        socketPath,
        token: 'e'.repeat(32),
        managedRoot: join(root, 'managed-deployment'),
        peerGid: process.getgid?.() ?? 0,
      }),
    ).rejects.toThrow(/not a regular file/);
    await expect(stat(socketPath)).rejects.toThrow(/ENOENT/);
  });

  /**
   * The staging file holds the bearer token in clear, in a directory the peer
   * group can traverse. A publish that fails after the write must not leave it
   * behind: the token stays valid for as long as the Updater serves with it, so
   * an abandoned copy is a live credential, not debris.
   */
  it('leaves no staged token behind when publishing fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-updater-status-'));
    // Renaming the staging file onto a directory fails after it has been
    // written — the last step of the publish, with the token already on disk.
    const tokenPath = join(root, 'token');
    await mkdir(tokenPath, { mode: 0o700 });
    await expect(
      publishControlToken(tokenPath, 'f'.repeat(32), process.getgid?.() ?? 0),
    ).rejects.toThrow();
    await expect(stat(`${tokenPath}.tmp`)).rejects.toThrow(/ENOENT/);
  });

  it('requires a strong control token before binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-updater-status-'));
    await expect(
      startUpdaterStatusServer({
        socketPath: join(root, 'updater.sock'),
        token: 'short',
        managedRoot: join(root, 'managed-deployment'),
      }),
    ).rejects.toThrow('at least 32 bytes');
  });
});

/**
 * The PostgreSQL delta (ADR 0008 D14).
 *
 * Advisory reporting, so the client's whole contract is that it never turns a
 * fact it could not learn into a failure of whatever asked. A missing socket, a
 * route an older Updater does not know, and a payload that makes no sense all
 * have to arrive as the same all-null answer.
 */
describe('the reported control-plane PostgreSQL state', () => {
  const unknown = { running: null, bundled: null, upToDate: null, blocked: null };

  it('answers unknown rather than throwing when the Updater is not there', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-updater-absent-'));
    await expect(
      readUpdaterPostgres({ socketPath: join(root, 'nothing.sock'), token: 'a'.repeat(32) }),
    ).resolves.toEqual(unknown);
  });

  it('answers unknown for a source that fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-updater-failing-'));
    const socketPath = join(root, 'control', 'updater.sock');
    const token = 'a'.repeat(32);
    servers.push(
      await startUpdaterStatusServer({
        socketPath,
        token,
        managedRoot: root,
        postgres: () => Promise.reject(new Error('no docker socket')),
      }),
    );
    await expect(readUpdaterPostgres({ socketPath, token })).resolves.toEqual(unknown);
  });

  it('reports the pin, the running digest and the operator block', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-updater-pg-'));
    const socketPath = join(root, 'control', 'updater.sock');
    const token = 'a'.repeat(32);
    const state = {
      running: `postgres:18-alpine@sha256:${'a'.repeat(64)}`,
      bundled: `postgres:19-alpine@sha256:${'b'.repeat(64)}`,
      upToDate: false,
      blocked: 'major-version-change' as const,
    };
    servers.push(
      await startUpdaterStatusServer({
        socketPath,
        token,
        managedRoot: root,
        postgres: async () => state,
      }),
    );
    await expect(readUpdaterPostgres({ socketPath, token })).resolves.toEqual(state);
  });
});

describe('managed Updater update action', () => {
  it('requires the bearer token for both update routes', async () => {
    const { socketPath } = await fixture({ managed: true });
    const wrong = { socketPath, token: 'b'.repeat(32) };
    await expect(readUpdaterOperation(wrong)).rejects.toMatchObject({ status: 401 });
    await expect(
      requestUpdaterOperation({ ...wrong, idempotencyKey: 'k1', targetDigest: image('b') }),
    ).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it('reports no operation before the first request', async () => {
    const { socketPath, token } = await fixture({ managed: true });
    await expect(readUpdaterOperation({ socketPath, token })).resolves.toBeNull();
  });

  it('journals an accepted request and hands it to the executor exactly once', async () => {
    const { socketPath, token, managedRoot, accepted } = await fixture({ managed: true });
    const operation = await requestUpdaterOperation({
      socketPath,
      token,
      idempotencyKey: 'k1',
      targetDigest: image('b'),
    });
    expect(operation).toMatchObject({
      state: 'preparing',
      phase: 'requested',
      generation: 1,
      previousDigest: image('a'),
      targetDigest: image('b'),
      step: 1,
      totalSteps: 16,
    });
    expect(await readUpdaterOperation({ socketPath, token })).toEqual(operation);
    expect((await readUpdateJournal(managedRoot))?.idempotencyKey).toBe('k1');
    expect(accepted).toHaveLength(1);

    // A retry with the same key is answered from the durable journal — the same
    // operation, never a second slot — but it DOES re-arm execution. An
    // operation whose step failed for a transient reason is otherwise driven by
    // nothing until the Updater restarts, and re-running is a no-op once the
    // operation has finished.
    await expect(
      requestUpdaterOperation({
        socketPath,
        token,
        idempotencyKey: 'k1',
        targetDigest: image('b'),
      }),
    ).resolves.toEqual(operation);
    expect(accepted).toHaveLength(2);
    expect(accepted[1]?.updateId).toBe(accepted[0]?.updateId);
  });

  it('does not re-arm execution for an operation that already finished', async () => {
    const { socketPath, token, managedRoot, accepted } = await fixture({ managed: true });
    const request = {
      socketPath,
      token,
      idempotencyKey: 'k1',
      targetDigest: image('b'),
    };
    await requestUpdaterOperation(request);
    await failUpdate(managedRoot, 'requested', 'requested-failed');

    await expect(requestUpdaterOperation(request)).resolves.toMatchObject({ state: 'failed' });
    expect(accepted).toHaveLength(1);
  });

  it('refuses a competing request while an operation is in flight', async () => {
    const { socketPath, token } = await fixture({ managed: true });
    await requestUpdaterOperation({
      socketPath,
      token,
      idempotencyKey: 'k1',
      targetDigest: image('b'),
    });
    await expect(
      requestUpdaterOperation({
        socketPath,
        token,
        idempotencyKey: 'k2',
        targetDigest: image('c'),
      }),
    ).rejects.toMatchObject({ status: 409, code: 'operation-in-progress' });
  });

  it('supersedes a terminal operation with a forward-fenced generation', async () => {
    const { socketPath, token, managedRoot } = await fixture({ managed: true });
    await requestUpdaterOperation({
      socketPath,
      token,
      idempotencyKey: 'k1',
      targetDigest: image('b'),
    });
    await advanceUpdate(managedRoot, 'requested', 'pulling');
    await failUpdate(managedRoot, 'pulling', 'pulling-failed');

    const next = await requestUpdaterOperation({
      socketPath,
      token,
      idempotencyKey: 'k2',
      targetDigest: image('c'),
    });
    expect(next).toMatchObject({ state: 'preparing', generation: 2, targetDigest: image('c') });
    expect(await readdir(managedRoot)).toContain('update-journal-g1.json');
  });

  // The single journal slot may only be superseded once its operation is
  // terminal, so an accepted request nothing can execute would sit at
  // `requested` and block every later update on that deployment.
  it('refuses a request when no executor is configured to carry it out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-updater-status-'));
    const managedRoot = join(root, 'managed-deployment');
    await mkdir(managedRoot, { mode: 0o700 });
    await chmod(managedRoot, 0o700);
    await initializeManagedDeployment({
      root: managedRoot,
      deploymentId: 'managed-1',
      spec: adoptionSpec(),
    });
    const socketPath = join(root, 'control', 'updater.sock');
    const token = 'a'.repeat(32);
    servers.push(await startUpdaterStatusServer({ socketPath, token, managedRoot }));

    await expect(
      requestUpdaterOperation({
        socketPath,
        token,
        idempotencyKey: 'k1',
        targetDigest: image('b'),
      }),
    ).rejects.toMatchObject({ status: 503, code: 'unavailable' });
    expect(await readUpdateJournal(managedRoot)).toBeNull();
  });

  // Archiving the finished journal and starting its successor cannot be one
  // atomic step. A crash in between leaves no live journal, and numbering the
  // next operation from that absence would restart the fence at 1 — a
  // generation the outgoing container still considers its own.
  it('keeps generations forward-fenced when no live journal survived', async () => {
    const { socketPath, token, managedRoot } = await fixture({ managed: true });
    await requestUpdaterOperation({
      socketPath,
      token,
      idempotencyKey: 'k1',
      targetDigest: image('b'),
    });
    await failUpdate(managedRoot, 'requested', 'requested-failed');
    // Exactly the crash window: the archive exists, the live journal does not.
    await archiveUpdateJournal(managedRoot);
    expect(await readUpdateJournal(managedRoot)).toBeNull();

    const next = await requestUpdaterOperation({
      socketPath,
      token,
      idempotencyKey: 'k2',
      targetDigest: image('c'),
    });
    expect(next).toMatchObject({ generation: 2 });
    expect(await readdir(managedRoot)).toContain('update-journal-g1.json');
  });

  it('rejects an unmanaged deployment, the current digest, and malformed input', async () => {
    const unmanaged = await fixture();
    await expect(
      requestUpdaterOperation({
        socketPath: unmanaged.socketPath,
        token: unmanaged.token,
        idempotencyKey: 'k1',
        targetDigest: image('b'),
      }),
    ).rejects.toMatchObject({ status: 503, code: 'unmanaged' });

    const { socketPath, token } = await fixture({ managed: true });
    await expect(
      requestUpdaterOperation({
        socketPath,
        token,
        idempotencyKey: 'k1',
        targetDigest: image('a'),
      }),
    ).rejects.toMatchObject({ status: 409, code: 'already-current' });
    for (const digest of [`ghcr.io/other/verity-server@sha256:${'b'.repeat(64)}`, 'latest', '']) {
      await expect(
        requestUpdaterOperation({ socketPath, token, idempotencyKey: 'k1', targetDigest: digest }),
      ).rejects.toMatchObject({ status: 400, code: 'invalid-request' });
    }
    await expect(
      requestUpdaterOperation({
        socketPath,
        token,
        idempotencyKey: 'not a key',
        targetDigest: image('b'),
      }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid-request' });
    expect(await readUpdaterOperation({ socketPath, token })).toBeNull();
  });

  it('surfaces a rejection as a typed error the Server can relay', async () => {
    const { socketPath, token } = await fixture();
    const error = await requestUpdaterOperation({
      socketPath,
      token,
      idempotencyKey: 'k1',
      targetDigest: image('b'),
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(UpdaterRequestError);
    expect((error as UpdaterRequestError).code).toBe('unmanaged');
  });
});

/**
 * `reconcileManagedServer` keeps a RUNNING Server whose environment no longer
 * matches the sealed spec, instead of refusing to run and taking the control
 * plane's only repair channel down with it. That is only defensible if the
 * disagreement is visible, so the verdict is reported here.
 *
 * A separate route on purpose. `/v1/deployment` is parsed with exact key counts
 * on the Server side and a cutover deliberately runs two Server generations at
 * once, so a new field there would make the outgoing generation reject the
 * authority it is handing over to — the same reason `/v1/agent-seed` is separate.
 */
describe('the startup reconcile verdict', () => {
  const readReconcile = (
    socketPath: string,
    token: string,
  ): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath,
          method: 'GET',
          path: '/v1/reconcile',
          headers: { authorization: `Bearer ${token}` },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.once('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.once('error', reject);
      req.end();
    });

  const boundary = async (
    reconcile?: Parameters<typeof startUpdaterStatusServer>[0]['reconcile'],
  ) => {
    const root = await mkdtemp(join(tmpdir(), 'verity-updater-reconcile-'));
    const managedRoot = join(root, 'managed-deployment');
    await mkdir(managedRoot, { mode: 0o700 });
    const socketPath = join(root, 'control', 'updater.sock');
    const token = 'r'.repeat(32);
    servers.push(
      await startUpdaterStatusServer({
        socketPath,
        token,
        managedRoot,
        ...(reconcile === undefined ? {} : { reconcile }),
      }),
    );
    return { socketPath, token };
  };

  it('reports a clean reconcile', async () => {
    const { socketPath, token } = await boundary({ status: 'ok' });
    expect(await readReconcile(socketPath, token)).toEqual({
      status: 200,
      body: JSON.stringify({ status: 'ok' }),
    });
  });

  it('reports drifting names and never their values', async () => {
    const { socketPath, token } = await boundary({
      status: 'drift',
      environment: ['DATABASE_URL', 'VERITY_SANDBOX_MEMORY'],
    });
    const { status, body } = await readReconcile(socketPath, token);
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      status: 'drift',
      environment: ['DATABASE_URL', 'VERITY_SANDBOX_MEMORY'],
    });
  });

  it('reports unknown when the boundary was started without a verdict', async () => {
    // An Updater that came up with an unfinished operation logs the failure and
    // never reaches a verdict. Answering `ok` there would be a claim nothing made.
    const { socketPath, token } = await boundary();
    expect(JSON.parse((await readReconcile(socketPath, token)).body)).toEqual({
      status: 'unknown',
    });
  });

  it('is behind the same bearer token as every other route', async () => {
    const { socketPath } = await boundary({ status: 'drift', environment: ['DATABASE_URL'] });
    expect((await readReconcile(socketPath, 'z'.repeat(32))).status).toBe(401);
  });

  it('does not widen the deployment payload the outgoing generation parses', async () => {
    // The reason this is a route rather than a field. A cutover runs two Server
    // generations at once and the older one parses `/v1/deployment` with exact
    // key counts, so a `reconcile` key there would break the handover.
    const { socketPath, token } = await boundary({
      status: 'drift',
      environment: ['DATABASE_URL'],
    });
    const deployment = await readUpdaterDeployment({ socketPath, token });
    expect(Object.keys(deployment)).toEqual(['managed', 'reason']);
  });
});

/**
 * The other half of the boundary: what a Server *concludes* from an answer.
 *
 * Every route is re-parsed by the caller rather than trusted, because most of
 * what the Updater returns is either derived from a journal on disk or relayed
 * verbatim from the other Server. A regression in these arms does not crash
 * anything — it makes the Server act on, and the operator read, a state nobody
 * asserted. The stub below is a plain socket that answers whatever a test
 * wants, which is the only way to reach the arms a healthy Updater never
 * produces.
 */
describe('what a Server concludes from an Updater answer', () => {
  const stubs: Server[] = [];
  afterEach(async () =>
    Promise.all(
      stubs.splice(0).map(async (server) => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }),
    ),
  );

  interface Stub {
    readonly socketPath: string;
    readonly token: string;
    /** Answer the next call with this status and this JSON document. */
    answer(status: number, value: unknown): void;
    /** Answer with a body that is not necessarily JSON at all. */
    answerRaw(status: number, body: string): void;
    /** Accept the call and never answer it. */
    hang(): void;
  }

  async function stub(): Promise<Stub> {
    // Canonical base: a unix socket path is compared verbatim by the client and
    // `tmpdir()` is itself a symlink on macOS.
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'bz-stub-'));
    const socketPath = join(directory, 's');
    let reply: { status: number; body: string } | null = { status: 200, body: '{}' };
    const server = createHttpServer((_req, res) => {
      if (reply === null) return;
      res.writeHead(reply.status, { 'content-type': 'application/json' }).end(reply.body);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    stubs.push(server);
    return {
      socketPath,
      token: 'a'.repeat(32),
      answer: (status, value) => (reply = { status, body: JSON.stringify(value) }),
      answerRaw: (status, body) => (reply = { status, body }),
      hang: () => (reply = null),
    };
  }

  const MARKER = { schemaVersion: 1, deploymentId: 'managed-1' } as const;
  const SPEC = sealDeploymentSpec({
    ...adoptionSpec(),
    schemaVersion: 2,
    deploymentId: 'managed-1',
  });

  const OPERATION = {
    updateId: 'update-1',
    state: 'preparing',
    phase: 'requested',
    step: 1,
    totalSteps: 16,
    generation: 1,
    previousDigest: image('a'),
    targetDigest: image('b'),
    failureCode: null,
    startedAt: '2026-08-09T00:00:01.000Z',
    updatedAt: '2026-08-09T00:00:02.000Z',
  } as const;

  const BINDING = {
    operationId: 'generation-2',
    targetDigest: image('b'),
    containerId: 'd'.repeat(64),
  } as const;

  /**
   * A deployment payload is the sealed authority the Server plans against, so
   * "I could not vouch for that" and "there is no managed deployment" must not
   * collapse into each other: the second is a legitimate state a Server acts
   * on, the first is a boundary answering something nobody sealed.
   */
  it('refuses a deployment payload it cannot vouch for instead of reading it as unmanaged', async () => {
    const stubbed = await stub();
    const call = { socketPath: stubbed.socketPath, token: stubbed.token };

    stubbed.answer(200, { managed: true, marker: MARKER, spec: SPEC });
    await expect(readUpdaterDeployment(call)).resolves.toEqual({
      managed: true,
      marker: MARKER,
      spec: SPEC,
    });
    stubbed.answer(200, { managed: false, reason: 'managed deployment has not been initialized' });
    await expect(readUpdaterDeployment(call)).resolves.toEqual({
      managed: false,
      reason: 'managed deployment has not been initialized',
    });

    for (const payload of [
      [{ managed: false, reason: 'x' }],
      'unmanaged',
      { managed: false },
      { managed: false, reason: 7 },
      { managed: false, reason: 'x', detail: 'y' },
      { managed: 'yes', marker: MARKER, spec: SPEC },
      // The exact widening `/v1/reconcile` and `/v1/agent-seed` exist to avoid:
      // an extra key here is rejected outright, not ignored.
      { managed: true, marker: MARKER, spec: SPEC, reconcile: { status: 'ok' } },
      { managed: true, marker: MARKER },
      { managed: true, marker: null, spec: SPEC },
      { managed: true, marker: { schemaVersion: 2, deploymentId: 'managed-1' }, spec: SPEC },
      { managed: true, marker: { schemaVersion: 1, deploymentId: 7 }, spec: SPEC },
      { managed: true, marker: { ...MARKER, extra: 1 }, spec: SPEC },
      { managed: true, marker: MARKER, spec: { ...SPEC, image: 'latest' } },
      // Marker and spec name different deployments — neither alone is wrong.
      { managed: true, marker: { schemaVersion: 1, deploymentId: 'other-1' }, spec: SPEC },
    ]) {
      stubbed.answer(200, payload);
      await expect(readUpdaterDeployment(call)).rejects.toThrow(
        'updater status returned invalid JSON',
      );
    }

    stubbed.answer(503, { error: 'unavailable' });
    await expect(readUpdaterDeployment(call)).rejects.toThrow('updater status returned HTTP 503');
  });

  /**
   * The error code is what a device is eventually shown. Only the closed set
   * may be relayed; anything else has to degrade to `unavailable` rather than
   * be passed through as a code the Server has no meaning for.
   */
  it('relays only closed-set error codes and degrades everything else to unavailable', async () => {
    const stubbed = await stub();
    const call = { socketPath: stubbed.socketPath, token: stubbed.token };
    const cases: readonly (readonly [unknown, UpdaterErrorCode])[] = [
      [{ error: 'operation-in-progress' }, 'operation-in-progress'],
      [{ error: 'already-current' }, 'already-current'],
      [{ error: 'unmanaged' }, 'unmanaged'],
      [{ error: 'invalid-request' }, 'invalid-request'],
      [{ error: 'not-a-code' }, 'unavailable'],
      [{ error: null }, 'unavailable'],
      [{}, 'unavailable'],
      // A bare string is not an error envelope, even when it spells a code.
      ['operation-in-progress', 'unavailable'],
      [['unmanaged'], 'unavailable'],
      [null, 'unavailable'],
    ];
    for (const [body, code] of cases) {
      stubbed.answer(409, body);
      const error = await readUpdaterOperation(call).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(UpdaterRequestError);
      expect(error).toMatchObject({
        status: 409,
        code,
        message: `updater rejected the request: ${code}`,
      });
    }
  });

  /** Progress reporting: an unreadable operation is an error, never `no
   * operation` — the second would read as "nothing is happening". */
  it('separates no operation from an operation it cannot re-parse', async () => {
    const stubbed = await stub();
    const call = { socketPath: stubbed.socketPath, token: stubbed.token };

    stubbed.answer(200, { operation: OPERATION });
    await expect(readUpdaterOperation(call)).resolves.toEqual(OPERATION);
    stubbed.answer(200, { operation: null });
    await expect(readUpdaterOperation(call)).resolves.toBeNull();

    for (const payload of [
      [{ operation: OPERATION }],
      'requested',
      {},
      { operation: OPERATION, note: 'x' },
      { update: OPERATION },
      { operation: 'requested' },
      // The plan the state names has 16 steps, so 15 describes no plan at all.
      { operation: { ...OPERATION, totalSteps: 15 } },
      // Phase and state contradict each other: `requested` is `preparing`.
      { operation: { ...OPERATION, state: 'completed' } },
    ]) {
      stubbed.answer(200, payload);
      await expect(readUpdaterOperation(call)).rejects.toThrow(
        'updater operation response is invalid',
      );
    }
  });

  /** An acceptance that names no operation leaves the caller with nothing to
   * poll, so it is an error rather than a `null` handed on as success. */
  it('refuses an acceptance that names no operation', async () => {
    const stubbed = await stub();
    const request = {
      socketPath: stubbed.socketPath,
      token: stubbed.token,
      idempotencyKey: 'k1',
      targetDigest: image('b'),
    };
    stubbed.answer(202, { operation: OPERATION });
    await expect(requestUpdaterOperation(request)).resolves.toEqual(OPERATION);

    stubbed.answer(202, { operation: null });
    await expect(requestUpdaterOperation(request)).rejects.toThrow(
      'updater operation response is invalid',
    );
    stubbed.answer(202, { operation: { ...OPERATION, generation: 0 } });
    await expect(requestUpdaterOperation(request)).rejects.toThrow(
      'updater operation response is invalid',
    );
    // 200 is not acceptance: only 202 means the slot was taken.
    stubbed.answer(200, { operation: OPERATION });
    await expect(requestUpdaterOperation(request)).rejects.toMatchObject({
      status: 200,
      code: 'unavailable',
    });
  });

  /**
   * The seed report must never fail a Server: it exists to say where the
   * sandbox toolkit came from, and a Server that cannot learn that still has to
   * start and serve. The distinction it must keep is `no seed mounted here`
   * versus `a seed is mounted and says nothing usable`.
   */
  it('never fails a Server over the agent seed and reports an unusable stamp as none', async () => {
    const stubbed = await stub();
    const call = { socketPath: stubbed.socketPath, token: stubbed.token };
    const stamp = {
      schemaVersion: 1,
      image: image('a'),
      version: '1.2.3',
      publishedAt: '2026-08-09T00:00:01.000Z',
    };

    stubbed.answer(200, { visible: true, stamp });
    await expect(readUpdaterAgentSeed(call)).resolves.toEqual({ visible: true, stamp });
    stubbed.answer(200, { visible: true, stamp: { ...stamp, publishedAt: null } });
    await expect(readUpdaterAgentSeed(call)).resolves.toEqual({
      visible: true,
      stamp: { ...stamp, publishedAt: null },
    });
    // Only the four known fields are carried; a wider stamp is narrowed, not
    // passed through.
    stubbed.answer(200, { visible: true, stamp: { ...stamp, source: 'somewhere' } });
    await expect(readUpdaterAgentSeed(call)).resolves.toEqual({ visible: true, stamp });

    for (const payload of [
      { visible: false, stamp },
      { visible: 'yes', stamp },
      { stamp },
      [{ visible: true, stamp }],
      'no seed',
      null,
    ]) {
      stubbed.answer(200, payload);
      await expect(readUpdaterAgentSeed(call)).resolves.toEqual({ visible: false, stamp: null });
    }
    // An Updater too old to know the route says 404, which is the same honest
    // reading as one without the mount.
    stubbed.answer(404, { error: 'not found' });
    await expect(readUpdaterAgentSeed(call)).resolves.toEqual({ visible: false, stamp: null });

    for (const unusable of [
      null,
      'v1',
      [],
      { ...stamp, schemaVersion: 2 },
      { ...stamp, image: 7 },
      { ...stamp, version: null },
      { ...stamp, publishedAt: 5 },
    ]) {
      stubbed.answer(200, { visible: true, stamp: unusable });
      await expect(readUpdaterAgentSeed(call)).resolves.toEqual({ visible: true, stamp: null });
    }
  });

  it('degrades an unreachable Updater agent-seed route without throwing', async () => {
    await expect(
      readUpdaterAgentSeed({ socketPath: '/does/not/exist/updater.sock', token: 'token' }),
    ).resolves.toEqual({ visible: false, stamp: null });
  });

  /** The relay is the one route whose payload the Updater never authored, so
   * the reader re-parses all of it — binding, identity key, and offer. */
  it('re-parses relayed handoff material instead of trusting the relay', async () => {
    const stubbed = await stub();
    const call = { socketPath: stubbed.socketPath, token: stubbed.token };
    const sender = createKeyHandoffSenderIdentity();
    const { offer } = createKeyHandoffReceiver(BINDING, sender.publicKey);

    stubbed.answer(200, { handoff: { binding: BINDING } });
    await expect(readUpdaterHandoff(call)).resolves.toEqual({ binding: BINDING });
    stubbed.answer(200, {
      handoff: { binding: BINDING, senderIdentityPublicKey: sender.publicKey, offer },
    });
    await expect(readUpdaterHandoff(call)).resolves.toEqual({
      binding: BINDING,
      senderIdentityPublicKey: sender.publicKey,
      offer,
    });
    stubbed.answer(200, { handoff: null });
    await expect(readUpdaterHandoff(call)).resolves.toBeNull();

    for (const payload of [
      [{ handoff: null }],
      'none',
      {},
      { handoff: { binding: BINDING }, extra: 1 },
      { relay: { binding: BINDING } },
      { handoff: 5 },
      { handoff: {} },
      { handoff: { binding: { ...BINDING, containerId: 'zz' } } },
      { handoff: { binding: BINDING, unexpected: 'x' } },
      { handoff: { binding: BINDING, senderIdentityPublicKey: 'not-a-key' } },
      { handoff: { binding: BINDING, offer: { ...offer, nonce: 'nope' } } },
      {
        handoff: {
          binding: BINDING,
          offer: { ...offer, containerId: 'c'.repeat(64) },
        },
      },
    ]) {
      stubbed.answer(200, payload);
      await expect(readUpdaterHandoff(call)).rejects.toThrow('updater handoff response is invalid');
    }

    stubbed.answer(503, { error: 'unavailable' });
    await expect(readUpdaterHandoff(call)).rejects.toMatchObject({
      status: 503,
      code: 'unavailable',
    });
  });

  /**
   * `false` from a publish means "the Updater declined" — a state the caller
   * proceeds from, sealed. Anything that is not a decision must therefore
   * throw rather than be flattened into a decline.
   */
  it('never flattens a failed relay call into a decline', async () => {
    const stubbed = await stub();
    const call = { socketPath: stubbed.socketPath, token: stubbed.token };
    const sender = createKeyHandoffSenderIdentity();

    stubbed.answer(202, { published: true });
    await expect(
      publishUpdaterHandoff(call, { senderIdentityPublicKey: sender.publicKey }),
    ).resolves.toBe(true);
    stubbed.answer(409, { published: false });
    await expect(
      publishUpdaterHandoff(call, { senderIdentityPublicKey: sender.publicKey }),
    ).resolves.toBe(false);
    for (const status of [200, 400, 401, 503]) {
      stubbed.answer(status, { error: 'unavailable' });
      await expect(
        publishUpdaterHandoff(call, { senderIdentityPublicKey: sender.publicKey }),
      ).rejects.toMatchObject({ status, code: 'invalid-request' });
    }

    const acknowledgement = { ...call, operationId: 'generation-2', state: 'quiesced' } as const;
    stubbed.answer(202, { recorded: true });
    await expect(acknowledgeUpdaterStandby(acknowledgement)).resolves.toBe(true);
    stubbed.answer(409, { recorded: false });
    await expect(acknowledgeUpdaterStandby(acknowledgement)).resolves.toBe(false);
    for (const status of [200, 400, 503]) {
      stubbed.answer(status, { error: 'unavailable' });
      await expect(acknowledgeUpdaterStandby(acknowledgement)).rejects.toMatchObject({
        status,
        code: 'invalid-request',
      });
    }
  });

  /** The claim decides whether the promoted Server starts unsealed. `null`
   * means "nothing to claim"; a malformed envelope must not read as that. */
  it('separates nothing to claim from an envelope it cannot re-parse', async () => {
    const stubbed = await stub();
    const call = { socketPath: stubbed.socketPath, token: stubbed.token };
    const sender = createKeyHandoffSenderIdentity();
    const { offer } = createKeyHandoffReceiver(BINDING, sender.publicKey);
    const envelope = sealUnlockedKey(Buffer.from('unlocked-data-key'), offer, sender);

    stubbed.answer(200, { envelope });
    await expect(claimUpdaterHandoffEnvelope(call)).resolves.toEqual(envelope);
    stubbed.answer(200, { envelope: null });
    await expect(claimUpdaterHandoffEnvelope(call)).resolves.toBeNull();

    for (const payload of [
      [{ envelope: null }],
      'none',
      null,
      {},
      { envelope, extra: 1 },
      { sealed: envelope },
      { envelope: { ...envelope, tag: '' } },
      { envelope: { ...envelope, senderIdentityPublicKey: 'not-a-key' } },
    ]) {
      stubbed.answer(200, payload);
      await expect(claimUpdaterHandoffEnvelope(call)).rejects.toThrow(
        'updater handoff response is invalid',
      );
    }

    stubbed.answer(409, { error: 'operation-in-progress' });
    await expect(claimUpdaterHandoffEnvelope(call)).rejects.toMatchObject({
      status: 409,
      code: 'operation-in-progress',
    });
  });

  /**
   * The directive decides whether the outgoing Server keeps being the control
   * plane. An unreadable one must not resolve to `null`, which the follower
   * reads as "no cutover, keep serving".
   */
  it('refuses a directive it cannot read rather than resolving it to keep serving', async () => {
    const stubbed = await stub();
    const call = { socketPath: stubbed.socketPath, token: stubbed.token };

    stubbed.answer(200, {
      standby: { directive: 'quiesced', operationId: 'generation-2', acknowledged: null },
    });
    await expect(readUpdaterStandby(call)).resolves.toEqual({
      directive: 'quiesced',
      operationId: 'generation-2',
      acknowledged: null,
    });
    stubbed.answer(200, {
      standby: { directive: 'serving', operationId: 'generation-2', acknowledged: 'quiesced' },
    });
    await expect(readUpdaterStandby(call)).resolves.toEqual({
      directive: 'serving',
      operationId: 'generation-2',
      acknowledged: 'quiesced',
    });
    stubbed.answer(200, { standby: null });
    await expect(readUpdaterStandby(call)).resolves.toBeNull();

    for (const payload of [
      [{ standby: null }],
      'serving',
      {},
      { standby: { directive: 'serving', operationId: 'g2', acknowledged: null }, extra: 1 },
      { directive: 'serving' },
      { standby: 5 },
      { standby: 'serving' },
      { standby: { directive: 'paused', operationId: 'g2', acknowledged: null } },
      // An unreadable acknowledgement is not the same as no acknowledgement:
      // only an explicit null means the Server has not answered yet.
      { standby: { directive: 'serving', operationId: 'g2', acknowledged: 'paused' } },
      { standby: { directive: 'serving', operationId: 5, acknowledged: null } },
      { standby: { directive: 'serving', operationId: 'g2' } },
      { standby: { directive: 'serving', operationId: 'g2', acknowledged: null, extra: 1 } },
    ]) {
      stubbed.answer(200, payload);
      await expect(readUpdaterStandby(call)).rejects.toThrow('updater standby response is invalid');
    }

    stubbed.answer(503, { error: 'unavailable' });
    await expect(readUpdaterStandby(call)).rejects.toMatchObject({
      status: 503,
      code: 'unavailable',
    });
  });

  /** Transport failures are reported as themselves. A truncated, unparseable
   * or absent answer must not reach a parser that would call it a state. */
  it('names a call it could not read whole, could not parse, or never got', async () => {
    const stubbed = await stub();
    const call = { socketPath: stubbed.socketPath, token: stubbed.token };

    stubbed.answerRaw(200, 'managed: false');
    await expect(readUpdaterDeployment(call)).rejects.toThrow('updater returned invalid JSON');

    stubbed.answer(200, { managed: false, reason: 'x'.repeat(70 * 1024) });
    await expect(readUpdaterDeployment(call)).rejects.toThrow('updater response exceeds limit');

    stubbed.hang();
    await expect(readUpdaterDeployment({ ...call, timeoutMs: 50 })).rejects.toThrow(
      'updater timed out',
    );
  });
});

/**
 * The two refusals a boundary owes an operator before it will serve anything,
 * and the answer it owes when the durable state behind a route cannot be read.
 *
 * `unavailable` is the only honest answer there: a boundary that reported "no
 * operation" for a journal it could not open would tell a waiting cutover that
 * nothing is in flight.
 */
describe('the control boundary refusing to guess', () => {
  async function canonicalRoot(): Promise<string> {
    return mkdtemp(join(await realpath(tmpdir()), 'bz-guard-'));
  }

  it('refuses a peer group that is not a group id', async () => {
    const root = await canonicalRoot();
    for (const peerGid of [-1, 1.5, Number.NaN]) {
      await expect(
        startUpdaterStatusServer({
          socketPath: join(root, 'control', 'updater.sock'),
          token: 'g'.repeat(32),
          managedRoot: join(root, 'managed-deployment'),
          peerGid,
        }),
      ).rejects.toThrow('updater control peer group must be a group ID');
    }
  });

  it('refuses to clear a control path that holds something other than a socket', async () => {
    const root = await canonicalRoot();
    const socketPath = join(root, 'control', 'updater.sock');
    await mkdir(join(root, 'control'), { recursive: true, mode: 0o700 });
    await writeFile(socketPath, 'not a socket', { mode: 0o600 });
    await expect(
      startUpdaterStatusServer({
        socketPath,
        token: 'h'.repeat(32),
        managedRoot: join(root, 'managed-deployment'),
      }),
    ).rejects.toThrow('updater control path exists and is not a socket');
    // Refused, not quietly unlinked.
    expect(await readFile(socketPath, 'utf8')).toBe('not a socket');
  });

  it('refuses a control directory reached through a symlink', async () => {
    const root = await canonicalRoot();
    await mkdir(join(root, 'real', 'control'), { recursive: true, mode: 0o700 });
    await symlink(join(root, 'real'), join(root, 'link'));
    await expect(
      startUpdaterStatusServer({
        socketPath: join(root, 'link', 'control', 'updater.sock'),
        token: 'i'.repeat(32),
        managedRoot: join(root, 'managed-deployment'),
      }),
    ).rejects.toThrow('updater control directory must be updater-owned and canonical');
  });

  async function unreadableBoundary(): Promise<{ socketPath: string; token: string }> {
    const root = await canonicalRoot();
    const socketPath = join(root, 'control', 'updater.sock');
    const token = 'j'.repeat(32);
    // Neither directory exists, so both the managed authority and the journal
    // fail to open — the shape of a boundary whose state volume went missing.
    servers.push(
      await startUpdaterStatusServer({
        socketPath,
        token,
        managedRoot: join(root, 'managed-deployment'),
        journalRoot: join(root, 'journal'),
        onOperationAccepted: () => undefined,
      }),
    );
    return { socketPath, token };
  }

  it('answers unavailable rather than no-operation when the journal cannot be read', async () => {
    const call = await unreadableBoundary();
    await expect(readUpdaterOperation(call)).rejects.toMatchObject({
      status: 503,
      code: 'unavailable',
    });
    await expect(readUpdaterStandby(call)).rejects.toMatchObject({
      status: 503,
      code: 'unavailable',
    });
    await expect(
      acknowledgeUpdaterStandby({ ...call, operationId: 'generation-1', state: 'quiesced' }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('answers that the managed authority is unavailable rather than unmanaged', async () => {
    const call = await unreadableBoundary();
    await expect(readUpdaterDeployment(call)).rejects.toThrow('updater status returned HTTP 503');
  });

  /** Malformed update requests are refused by shape alone, before the journal
   * or the sealed authority is consulted at all. */
  it('refuses a malformed update request by shape alone', async () => {
    const { socketPath, token } = await unreadableBoundary();
    const post = (body: string): Promise<{ status: number; body: string }> =>
      new Promise((resolve) => {
        const req = httpRequest(
          {
            socketPath,
            method: 'POST',
            path: '/v1/update',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          },
          (res) => {
            let received = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => (received += chunk));
            res.once('end', () => resolve({ status: res.statusCode ?? 0, body: received }));
          },
        );
        // A body refused mid-stream is answered by hanging up, which the client
        // sees as a reset; reported as 0 so "refused" is distinguishable.
        req.once('error', () => resolve({ status: 0, body: '' }));
        req.end(body);
      });

    for (const body of [
      '',
      'not json',
      '[]',
      'null',
      '"k1"',
      JSON.stringify({ idempotencyKey: 'k1' }),
      JSON.stringify({ idempotencyKey: 'k1', targetDigest: image('b'), force: true }),
      JSON.stringify({ idempotencyKey: 'not a key', targetDigest: image('b') }),
      JSON.stringify({ idempotencyKey: 'k1', targetDigest: 'latest' }),
      JSON.stringify({ idempotencyKey: 'k1', targetDigest: image('B') }),
    ]) {
      expect(await post(body)).toEqual({
        status: 400,
        body: JSON.stringify({ error: 'invalid-request' }),
      });
    }
    // Past the 4 KiB request limit the boundary hangs up instead of buffering.
    expect((await post(JSON.stringify({ idempotencyKey: 'x'.repeat(8192) }))).status).toBe(0);
  });
});
