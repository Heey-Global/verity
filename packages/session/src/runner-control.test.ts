import { appendFile, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PermissionDecision, PermissionRequest } from '@verity/adapter-claude';
import type { AgentEvent } from '@verity/events';
import type { RunnerFrameIngest, RunnerFrameIngestResult, SequencedEvent } from '@verity/store';
import { InMemoryEventBus } from './bus.js';
import type { Backend } from './backend.js';
import type { RunResult, RunTurnOptions, SteerMessage } from './backend-contract.js';
import {
  connectControl,
  ControlCommandRejectedError,
  inspectControl,
  serveControl,
  type ControlHandlers,
  type ControlSocketClient,
  type ControlSocketServer,
} from './runner-control.js';
import { FileTailRunnerClient, type RunnerFrameStore } from './file-tail-runner-client.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'verity-runner-control-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const socketPath = (): string => join(dir, randomUUID(), 'control.sock');

/** A recording handler set standing in for the Runner-side turn's control methods.
 * `steer` returns the configured boolean; every op is recorded so the tests can
 * assert what crossed the socket. */
function fakeHandlers(steerResult = true): ControlHandlers & {
  steerSeen: SteerMessage[];
  cancelCalls: number;
  answers: { toolUseId: string; decision: PermissionDecision }[];
} {
  const steerSeen: SteerMessage[] = [];
  const answers: { toolUseId: string; decision: PermissionDecision }[] = [];
  let cancelCalls = 0;
  return {
    steerSeen,
    answers,
    get cancelCalls() {
      return cancelCalls;
    },
    steer(message) {
      steerSeen.push(message);
      return steerResult;
    },
    cancel() {
      cancelCalls += 1;
      return true;
    },
    answerPermission(toolUseId, decision) {
      answers.push({ toolUseId, decision });
      return true;
    },
  };
}

describe('control socket transport (ADR 0006 Stage 2.1b, standalone)', () => {
  let server: ControlSocketServer | undefined;
  let client: ControlSocketClient | undefined;

  afterEach(async () => {
    client?.close();
    await server?.close();
    server = undefined;
    client = undefined;
  });

  it('rejects a same-uid controller without the per-turn capability', async () => {
    const path = socketPath();
    const handlers = fakeHandlers();
    server = await serveControl(path, handlers, {
      authorizeAcquire: (_id, _current, capability) => capability === 'unguessable-start-id',
    });
    await expect(connectControl(path, { capability: 'wrong' })).rejects.toThrow(
      'control attach rejected',
    );
    expect(handlers.answers).toEqual([]);
    client = await connectControl(path, { capability: 'unguessable-start-id' });
  });

  it('re-authorizes the same controller id on every acquire', async () => {
    const path = socketPath();
    const handlers = fakeHandlers();
    const controllerId = 'stable-controller';
    server = await serveControl(path, handlers, {
      authorizeAcquire: (_id, _current, capability) => capability === 'unguessable-start-id',
    });
    client = await connectControl(path, {
      controllerId,
      capability: 'unguessable-start-id',
    });
    await expect(connectControl(path, { controllerId, capability: 'wrong' })).rejects.toThrow(
      'control attach rejected',
    );
  });

  it('steer round-trips the handler boolean back over the socket', async () => {
    const handlers = fakeHandlers(true);
    const path = socketPath();
    server = await serveControl(path, handlers);
    client = await connectControl(path);

    const msg: SteerMessage = { text: 'keep going' };
    await expect(client.steer(msg)).resolves.toBe(true);
    expect(handlers.steerSeen).toEqual([msg]);
  });

  it('steer resolves false when the handler reports not-injected', async () => {
    const handlers = fakeHandlers(false);
    const path = socketPath();
    server = await serveControl(path, handlers);
    client = await connectControl(path);

    await expect(client.steer({ text: 'x' })).resolves.toBe(false);
  });

  it('concurrent steers correlate their replies by id', async () => {
    // A handler that resolves each steer with a distinct latency, so replies come back
    // OUT of request order — the client must still match each reply to its own steer.
    const seen: SteerMessage[] = [];
    const handlers: ControlHandlers = {
      steer: async (message) => {
        seen.push(message);
        // 'slow' resolves after 'fast', inverting the arrival order.
        const wait = message.text === 'slow' ? 30 : 1;
        await new Promise((r) => setTimeout(r, wait));
        // Encode which message this was so we can assert the correlation held.
        return message.text === 'slow';
      },
      cancel: () => true,
      answerPermission: () => true,
    };
    const path = socketPath();
    server = await serveControl(path, handlers);
    client = await connectControl(path);

    const slow = client.steer({ text: 'slow' });
    const fast = client.steer({ text: 'fast' });
    const [slowInjected, fastInjected] = await Promise.all([slow, fast]);
    // Correlation held: slow→true, fast→false, despite reply order being fast-first.
    expect(slowInjected).toBe(true);
    expect(fastInjected).toBe(false);
    expect(seen.map((m) => m.text).sort()).toEqual(['fast', 'slow']);
  });

  it('acknowledges cancel and answerPermission after they reach the handler', async () => {
    const handlers = fakeHandlers();
    const path = socketPath();
    server = await serveControl(path, handlers);
    client = await connectControl(path);

    await expect(client.cancel({ commandId: 'cancel-ack' })).resolves.toEqual({
      commandId: 'cancel-ack',
      applied: true,
    });
    const decision: PermissionDecision = { behavior: 'deny', message: 'no' };
    await expect(
      client.answerPermission('tool-1', decision, { commandId: 'permission-ack' }),
    ).resolves.toEqual({ commandId: 'permission-ack', applied: true });

    await waitFor(() => handlers.cancelCalls === 1 && handlers.answers.length === 1);
    expect(handlers.cancelCalls).toBe(1);
    expect(handlers.answers).toEqual([{ toolUseId: 'tool-1', decision }]);
  });

  it('delivers an in-flight command reply before closing the control socket', async () => {
    let handlerStarted!: () => void;
    let releaseHandler!: () => void;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const path = socketPath();
    server = await serveControl(path, {
      steer: () => true,
      cancel: () => true,
      answerPermission: async () => {
        handlerStarted();
        await release;
        return true;
      },
    });
    client = await connectControl(path);

    const answer = client.answerPermission(
      'tool-1',
      { behavior: 'allow' },
      { commandId: 'permission-before-close' },
    );
    await started;
    const closing = server.close();
    releaseHandler();

    await expect(answer).resolves.toEqual({
      commandId: 'permission-before-close',
      applied: true,
    });
    await closing;
  });

  it('delivers control over a socket path longer than sun_path', async () => {
    // Production shape: the Runner binds the socket at a SHORT in-container path,
    // while the Server references the very same socket through a LONG bind-mount
    // path (a project uuid plus a turn uuid deep). connect(2) rejects paths over
    // ~104-108 bytes (sun_path) outright, so the client must reach the socket
    // through a short alias instead of the literal path.
    const handlers = fakeHandlers();
    const shortPath = socketPath();
    server = await serveControl(shortPath, handlers, { turnId: 'turn-long-path' });
    const longDir = join(dir, `runners-${'p'.repeat(36)}`, 'turns', `t-${'u'.repeat(36)}`);
    await mkdir(longDir, { recursive: true });
    const longPath = join(longDir, 'control.sock');
    expect(Buffer.byteLength(longPath)).toBeGreaterThan(108);
    await symlink(shortPath, longPath);

    const relativeLongPath = relative(process.cwd(), longPath);
    expect(Buffer.byteLength(relativeLongPath)).toBeGreaterThan(108);
    client = await connectControl(relativeLongPath, { turnId: 'turn-long-path' });
    const decision: PermissionDecision = { behavior: 'allow' };
    await expect(
      client.answerPermission('tool-long', decision, { commandId: 'permission-long' }),
    ).resolves.toEqual({ commandId: 'permission-long', applied: true });
    await waitFor(() => handlers.answers.length === 1);
    expect(handlers.answers).toEqual([{ toolUseId: 'tool-long', decision }]);
  });

  it('signal-abort closes the server (and unlinks the socket)', async () => {
    const handlers = fakeHandlers();
    const path = socketPath();
    const controller = new AbortController();
    server = await serveControl(path, handlers, { signal: controller.signal });
    client = await connectControl(path);

    controller.abort();
    await server.closed;

    // A fresh connect to the now-closed socket must fail (server is down + socket
    // file removed).
    await expect(connectControl(path)).rejects.toBeDefined();
  });

  it('reports an ambiguous steer when the socket closes before its ACK', async () => {
    // A handler that never replies (parks the steer), so closing the socket is the
    // only thing that can settle the client's steer promise.
    const handlers: ControlHandlers = {
      steer: () => new Promise<boolean>(() => {}),
      cancel: () => true,
      answerPermission: () => true,
    };
    const path = socketPath();
    server = await serveControl(path, handlers);
    client = await connectControl(path);

    const pending = client.steer({ text: 'never answered' }, { commandId: 'ambiguous-steer' });
    client.close();
    await expect(pending).rejects.toMatchObject({
      name: 'ControlDeliveryUnknownError',
      commandId: 'ambiguous-steer',
    });
  });
});

describe('control socket transport — edge cases', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('reports a rejected steer handler as ambiguous rather than queue-safe false', async () => {
    const handlers: ControlHandlers = {
      steer: async () => {
        throw new Error('handler boom');
      },
      cancel: () => true,
      answerPermission: () => true,
    };
    const path = socketPath();
    const server = await serveControl(path, handlers, { authorizeAcquire: () => true });
    const client = await connectControl(path);
    cleanups.push(
      () => client.close(),
      () => server.close(),
    );
    await expect(
      client.steer({ text: 'x' }, { commandId: 'handler-failed' }),
    ).rejects.toMatchObject({
      name: 'ControlDeliveryUnknownError',
      commandId: 'handler-failed',
    });
  });

  it('carries a handler no-op through the ACK as applied false', async () => {
    const path = socketPath();
    const server = await serveControl(path, {
      steer: () => false,
      cancel: () => false,
      answerPermission: () => false,
    });
    const client = await connectControl(path);
    cleanups.push(
      () => client.close(),
      () => server.close(),
    );
    await expect(client.cancel({ commandId: 'already-cancelled' })).resolves.toEqual({
      commandId: 'already-cancelled',
      applied: false,
    });
  });

  it('a malformed control line is dropped without tearing down the turn', async () => {
    const handlers = fakeHandlers();
    const path = socketPath();
    const server = await serveControl(path, handlers, { authorizeAcquire: () => true });
    const raw: Socket = createConnection(path);
    await new Promise<void>((resolve) => raw.once('connect', () => resolve()));
    cleanups.push(
      () => {
        raw.destroy();
      },
      () => server.close(),
    );
    raw.write(
      `${JSON.stringify({
        kind: 'attach',
        turnId: path,
        controllerId: 'raw-malformed-test',
        mode: 'acquire',
        protocolVersion: 1,
      })}\n`,
    );
    await new Promise<void>((resolve) => raw.once('data', () => resolve()));
    raw.write('this is not json\n'); // parse failure → dropped, not fatal
    raw.write(
      `${JSON.stringify({
        kind: 'cancel',
        turnId: path,
        commandId: 'valid-after-garbage',
        leaseEpoch: 1,
      })}\n`,
    ); // the next valid line still dispatches
    await waitFor(() => handlers.cancelCalls === 1);
    expect(handlers.cancelCalls).toBe(1);
  });

  it('drops a connection whose unterminated control frame exceeds the size limit', async () => {
    const path = socketPath();
    const server = await serveControl(path, fakeHandlers(), { authorizeAcquire: () => true });
    const raw = createConnection(path);
    await new Promise<void>((resolve) => raw.once('connect', resolve));
    const closed = new Promise<void>((resolve) => raw.once('close', () => resolve()));
    raw.write(Buffer.alloc(1024 * 1024 + 1, 0x61));
    await closed;

    // Only the offending connection is dropped; the turn remains attachable.
    const healthy = await connectControl(path);
    cleanups.push(
      () => healthy.close(),
      () => server.close(),
    );
    await expect(healthy.cancel({ commandId: 'after-overflow' })).resolves.toMatchObject({
      applied: true,
    });
  });

  it('a pre-aborted signal closes the server immediately', async () => {
    const controller = new AbortController();
    controller.abort(); // aborted BEFORE serveControl → the immediate-close branch
    const path = socketPath();
    const server = await serveControl(path, fakeHandlers(), { signal: controller.signal });
    await server.closed;
    await expect(connectControl(path)).rejects.toBeDefined();
  });

  it('close is idempotent — a concurrent second call awaits the first', async () => {
    const path = socketPath();
    const server = await serveControl(path, fakeHandlers());
    await Promise.all([server.close(), server.close()]); // second hits the `closing` guard
    await server.closed;
    await expect(connectControl(path)).rejects.toBeDefined();
  });

  it('the client ignores garbage, unrelated, and unknown-command replies', async () => {
    const path = join(dir, `raw-${randomUUID()}.sock`); // parent `dir` already exists
    const raw: Server = createServer((sock) => {
      sock.on('data', (buf) => {
        const req = JSON.parse(buf.toString().trim()) as {
          kind: string;
          mode?: string;
          turnId: string;
          controllerId?: string;
          commandId?: string;
        };
        if (req.kind === 'attach') {
          if (req.mode === 'inspect') {
            sock.write(
              `${JSON.stringify({
                kind: 'inspected',
                turnId: req.turnId,
                protocolVersion: 1,
                lastFrameSeq: 0,
                turnStatus: 'running',
                outstandingPermissions: [],
              })}\n`,
            );
            return;
          }
          sock.write(
            `${JSON.stringify({
              kind: 'attached',
              turnId: req.turnId,
              controllerId: req.controllerId,
              leaseEpoch: 1,
            })}\n`,
          );
          return;
        }
        if (req.commandId === undefined) return;
        sock.write('not json at all\n'); // parse-drop on the client
        sock.write('null\n1\n'); // valid JSON primitives are ignored safely
        sock.write(`${JSON.stringify({ kind: 'other' })}\n`); // unrelated reply → ignored
        sock.write(
          `${JSON.stringify({ kind: 'ack', commandId: `${req.commandId}-other`, injected: true })}\n`,
        ); // unknown command id
        sock.write(
          `${JSON.stringify({ kind: 'ack', commandId: req.commandId, injected: true })}\n`,
        ); // the real reply
      });
    });
    await new Promise<void>((resolve) => raw.listen(path, () => resolve()));
    const client = await connectControl(path);
    cleanups.push(
      () => client.close(),
      () => new Promise<void>((resolve) => raw.close(() => resolve())),
    );
    // Resolves true off the correctly-correlated reply, having ignored all the noise.
    await expect(client.steer({ text: 'x' })).resolves.toBe(true);
  });

  it('does not treat a bare ACK as an applied control command', async () => {
    const path = join(dir, `bare-ack-${randomUUID()}.sock`);
    const raw: Server = createServer((sock) => {
      sock.on('data', (buf) => {
        const request = JSON.parse(buf.toString('utf8').trim()) as Record<string, unknown>;
        if (request.kind === 'attach') {
          if (request.mode === 'inspect') {
            sock.write(
              `${JSON.stringify({
                kind: 'inspected',
                turnId: request.turnId,
                protocolVersion: 1,
                lastFrameSeq: 0,
                turnStatus: 'running',
                outstandingPermissions: [],
              })}\n`,
            );
            return;
          }
          sock.write(
            `${JSON.stringify({
              kind: 'attached',
              turnId: request.turnId,
              controllerId: request.controllerId,
              leaseEpoch: 1,
            })}\n`,
          );
          return;
        }
        if (request.kind === 'answer-permission' || request.kind === 'cancel') {
          sock.write(`${JSON.stringify({ kind: 'ack', commandId: request.commandId })}\n`);
        }
      });
    });
    await new Promise<void>((resolve) => raw.listen(path, () => resolve()));
    const client = await connectControl(path);
    cleanups.push(
      () => client.close(),
      () => new Promise<void>((resolve) => raw.close(() => resolve())),
    );

    await expect(client.answerPermission('tool-1', { behavior: 'allow' })).resolves.toMatchObject({
      applied: false,
    });
    await expect(client.cancel()).resolves.toMatchObject({ applied: false });
  });

  it('attaches N+1 to an inspected-by-supervisor N Runner that predates inspect', async () => {
    const path = join(dir, `legacy-${randomUUID()}.sock`);
    let acquired = 0;
    const legacy: Server = createServer((sock) => {
      sock.on('data', (buf) => {
        const request = JSON.parse(buf.toString('utf8').trim()) as Record<string, unknown>;
        // Exact pre-change behavior: unknown `inspect` would be ignored. The trusted
        // supervisor-state path skips it and sends the legacy-compatible acquire.
        if (request.kind !== 'attach' || request.mode !== 'acquire') return;
        acquired += 1;
        sock.write(
          `${JSON.stringify({
            kind: 'attached',
            turnId: request.turnId,
            controllerId: request.controllerId,
            leaseEpoch: 1,
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve) => legacy.listen(path, resolve));
    const client = await connectControl(path, { verifiedProtocolVersion: 1 });
    cleanups.push(
      () => client.close(),
      () => new Promise<void>((resolve) => legacy.close(() => resolve())),
    );
    expect(client.leaseEpoch).toBe(1);
    expect(acquired).toBe(1);
  });

  it('replays a journaled ACK without applying a command twice after reconnect', async () => {
    const handlers = fakeHandlers();
    const path = socketPath();
    const server = await serveControl(path, handlers);
    cleanups.push(() => server.close());

    // Simulate an ACK getting lost: the first connection applies the command and is
    // dropped before its caller consumes the reply.
    const raw = createConnection(path);
    await new Promise<void>((resolve) => raw.once('connect', resolve));
    raw.write(
      `${JSON.stringify({
        kind: 'attach',
        turnId: path,
        controllerId: 'retry-controller',
        mode: 'acquire',
        protocolVersion: 1,
      })}\n`,
    );
    await new Promise<void>((resolve) => raw.once('data', () => resolve()));
    raw.write(
      `${JSON.stringify({
        kind: 'cancel',
        turnId: path,
        commandId: 'cancel-1',
        leaseEpoch: 1,
      })}\n`,
    );
    await waitFor(() => handlers.cancelCalls === 1);
    raw.destroy();

    const retry = await connectControl(path, {
      controllerId: 'retry-controller',
      resumeLeaseEpoch: 1,
    });
    cleanups.push(() => retry.close());
    await expect(retry.cancel({ commandId: 'cancel-1' })).resolves.toEqual({
      commandId: 'cancel-1',
      applied: true,
    });
    expect(handlers.cancelCalls).toBe(1);
  });

  it('coalesces concurrent retries with the same command id', async () => {
    const handlers = fakeHandlers();
    const path = socketPath();
    const server = await serveControl(path, handlers);
    const client = await connectControl(path);
    cleanups.push(
      () => client.close(),
      () => server.close(),
    );

    const first = client.cancel({ commandId: 'racing-cancel' });
    const retry = client.cancel({ commandId: 'racing-cancel' });
    await expect(Promise.all([first, retry])).resolves.toEqual([
      { commandId: 'racing-cancel', applied: true },
      { commandId: 'racing-cancel', applied: true },
    ]);
    expect(handlers.cancelCalls).toBe(1);
  });

  it('rejects command-id reuse with a different payload', async () => {
    const handlers = fakeHandlers();
    const path = socketPath();
    const server = await serveControl(path, handlers);
    const client = await connectControl(path);
    cleanups.push(
      () => client.close(),
      () => server.close(),
    );

    await expect(client.cancel({ commandId: 'same-id' })).resolves.toEqual({
      commandId: 'same-id',
      applied: true,
    });
    await expect(
      client.answerPermission(
        'tool-1',
        { behavior: 'deny', message: 'no' },
        { commandId: 'same-id' },
      ),
    ).resolves.toEqual({
      commandId: 'same-id',
      applied: false,
      reason: 'command-conflict',
    });
    expect(handlers.cancelCalls).toBe(1);
    expect(handlers.answers).toEqual([]);
  });

  it('fences commands from a superseded controller lease', async () => {
    const handlers = fakeHandlers();
    const path = socketPath();
    const server = await serveControl(path, handlers, { authorizeAcquire: () => true });
    const oldClient = await connectControl(path, { controllerId: 'old-controller' });
    await expect(oldClient.cancel({ commandId: 'old-command' })).resolves.toEqual({
      commandId: 'old-command',
      applied: true,
    });
    const newClient = await connectControl(path, { controllerId: 'new-controller' });
    cleanups.push(
      () => oldClient.close(),
      () => newClient.close(),
      () => server.close(),
    );
    await expect(newClient.cancel({ commandId: 'new-command' })).resolves.toEqual({
      commandId: 'new-command',
      applied: true,
    });
    await expect(oldClient.cancel({ commandId: 'stale-command' })).resolves.toEqual({
      commandId: 'stale-command',
      applied: false,
      reason: 'stale-lease',
    });
    // Even an old command whose success was journaled before takeover is fenced.
    await expect(oldClient.cancel({ commandId: 'old-command' })).resolves.toEqual({
      commandId: 'old-command',
      applied: false,
      reason: 'stale-lease',
    });
    expect(handlers.cancelCalls).toBe(2);
  });

  it('does not send an old success ACK when takeover races an in-flight command', async () => {
    let finishSteer!: (injected: boolean) => void;
    const handlers = fakeHandlers();
    handlers.steer = () =>
      new Promise<boolean>((resolve) => {
        finishSteer = resolve;
      });
    const path = socketPath();
    const server = await serveControl(path, handlers, { authorizeAcquire: () => true });
    const oldClient = await connectControl(path, { controllerId: 'old-in-flight' });
    const pending = oldClient.steer({ text: 'in flight' }, { commandId: 'in-flight-steer' });
    await waitFor(() => finishSteer !== undefined);
    const newClient = await connectControl(path, { controllerId: 'takeover' });
    finishSteer(true);
    cleanups.push(
      () => oldClient.close(),
      () => newClient.close(),
      () => server.close(),
    );

    await expect(pending).rejects.toMatchObject({
      name: 'ControlCommandRejectedError',
      commandId: 'in-flight-steer',
      reason: 'stale-lease',
    });
  });

  it('binds attach to the expected turn id', async () => {
    const path = socketPath();
    const server = await serveControl(path, fakeHandlers(), { turnId: 'turn-a' });
    cleanups.push(() => server.close());
    await expect(connectControl(path, { turnId: 'turn-b' })).rejects.toThrow(
      'control inspect rejected: wrong-turn',
    );
  });

  it('rejects an incompatible cutover before lease takeover', async () => {
    const path = socketPath();
    const handlers = fakeHandlers();
    const server = await serveControl(path, handlers, {
      turnId: 'turn-cutover',
      authorizeAcquire: () => true,
    });
    const active = await connectControl(path, {
      turnId: 'turn-cutover',
      controllerId: 'server-n-plus-1',
    });
    cleanups.push(
      () => active.close(),
      () => server.close(),
    );
    expect(active.leaseEpoch).toBe(1);

    await expect(
      inspectControl(path, { turnId: 'turn-cutover', protocolVersion: 99 }),
    ).rejects.toThrow('control inspect rejected: incompatible-protocol');
    const incompatibleAcquire = createConnection(path);
    await new Promise<void>((resolve, reject) => {
      incompatibleAcquire.once('connect', resolve);
      incompatibleAcquire.once('error', reject);
    });
    const rejected = new Promise<Record<string, unknown>>((resolve) => {
      incompatibleAcquire.once('data', (chunk) =>
        resolve(JSON.parse(chunk.toString('utf8').trim()) as Record<string, unknown>),
      );
    });
    incompatibleAcquire.write(
      `${JSON.stringify({
        kind: 'attach',
        turnId: 'turn-cutover',
        controllerId: 'incompatible-toctou',
        mode: 'acquire',
        protocolVersion: 99,
      })}\n`,
    );
    await expect(rejected).resolves.toMatchObject({
      kind: 'attach-reject',
      reason: 'incompatible-protocol',
    });
    incompatibleAcquire.destroy();
    // Omitting the version is not a legacy escape hatch on a new Runner: the line
    // is invalid and cannot mutate the active lease.
    const versionlessAcquire = createConnection(path);
    await new Promise<void>((resolve, reject) => {
      versionlessAcquire.once('connect', resolve);
      versionlessAcquire.once('error', reject);
    });
    versionlessAcquire.write(
      `${JSON.stringify({
        kind: 'attach',
        turnId: 'turn-cutover',
        controllerId: 'versionless-candidate',
        mode: 'acquire',
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    versionlessAcquire.destroy();
    // Read-only preflight did not fence or advance the live controller.
    await expect(active.steer({ text: 'still owned by N+1' })).resolves.toBe(true);

    const compatible = await connectControl(path, {
      turnId: 'turn-cutover',
      controllerId: 'compatible-successor',
    });
    cleanups.push(() => compatible.close());
    expect(compatible.leaseEpoch).toBe(2);
    await expect(compatible.steer({ text: 'owned after cutover' })).resolves.toBe(true);
    await expect(active.steer({ text: 'stale after cutover' })).rejects.toMatchObject({
      reason: 'stale-lease',
    });
    expect(handlers.steerSeen).toEqual([
      { text: 'still owned by N+1' },
      { text: 'owned after cutover' },
    ]);
  });

  it('does not let an unauthorised controller reacquire a fenced turn', async () => {
    const path = socketPath();
    const server = await serveControl(path, fakeHandlers());
    const owner = await connectControl(path, { controllerId: 'owner' });
    cleanups.push(
      () => owner.close(),
      () => server.close(),
    );
    await expect(connectControl(path, { controllerId: 'stale-server' })).rejects.toThrow(
      'control attach rejected: stale-controller',
    );
  });

  it('resumes the same lease but rejects it after another controller takes over', async () => {
    const path = socketPath();
    const server = await serveControl(path, fakeHandlers(), { authorizeAcquire: () => true });
    const first = await connectControl(path, { controllerId: 'stable-controller' });
    const epoch = first.leaseEpoch;
    first.close();
    const resumed = await connectControl(path, {
      controllerId: 'stable-controller',
      resumeLeaseEpoch: epoch,
    });
    expect(resumed.leaseEpoch).toBe(epoch);
    const replacement = await connectControl(path, { controllerId: 'replacement' });
    cleanups.push(
      () => resumed.close(),
      () => replacement.close(),
      () => server.close(),
    );
    await expect(
      connectControl(path, {
        controllerId: 'stable-controller',
        resumeLeaseEpoch: epoch,
      }),
    ).rejects.toThrow('control attach rejected: stale-controller');
  });

  it('canonicalizes nested payloads when matching a retried command', async () => {
    const handlers = fakeHandlers();
    const path = socketPath();
    const server = await serveControl(path, handlers);
    const client = await connectControl(path);
    cleanups.push(
      () => client.close(),
      () => server.close(),
    );
    const first: PermissionDecision = { behavior: 'allow', updatedInput: { b: 2, a: 1 } };
    const reconstructed: PermissionDecision = {
      behavior: 'allow',
      updatedInput: { a: 1, b: 2 },
    };
    await expect(
      client.answerPermission('tool-1', first, { commandId: 'canonical-decision' }),
    ).resolves.toMatchObject({ applied: true });
    await expect(
      client.answerPermission('tool-1', reconstructed, { commandId: 'canonical-decision' }),
    ).resolves.toMatchObject({ applied: true });
    expect(handlers.answers).toHaveLength(1);
  });
});

// --- End-to-end: control over the REAL socket through RunnerServer + client -------

const SESSION_ID = 'sess-control-e2e';
const WORKTREE = '/wt/control';
const EVENT_ONE: AgentEvent = { t: 'text', delta: 'hello' };
const RESULT: RunResult = { sessionId: SESSION_ID, exitCode: 0, stderr: '', aborted: false };
const PERMISSION_REQUEST: PermissionRequest = {
  requestId: 'req-1',
  toolName: 'Bash',
  input: { command: 'ls' },
  toolUseId: 'tool-1',
};
const PERMISSION_EVENT: AgentEvent = {
  t: 'permission',
  id: 'tool-1',
  tool: 'Bash',
  input: { command: 'ls' },
  riskClass: 'ask',
  // The scripted backend below is a native one, so the prompt carries the native
  // channel and the card may offer every standing grant scope (ADR 0014 D3).
  grantChannel: 'acp',
};

/** A scripted {@link Backend} for the e2e path: binds the session, emits one event,
 * raises a permission prompt, and records steer/cancel/permission answers so the test
 * can assert control crossed the socket. */
function scriptedBackend() {
  const steerSeen: SteerMessage[] = [];
  const permissionAnswers: PermissionDecision[] = [];
  let cancelled = false;
  let settle: (r: RunResult) => void = () => {};
  let resolveStarted: () => void = () => {};
  const started = new Promise<void>((res) => {
    resolveStarted = res;
  });
  const backend: Backend = {
    // An attested native runner protocol, which is what puts the prompts this
    // fixture asserts on the native channel (ADR 0014 D3). Omitting it would fail
    // closed to `acp`, so it has to be declared rather than assumed.
    runnerSupervisorBackend: 'codex-acp',
    run(opts: RunTurnOptions): Promise<RunResult> {
      opts.signal?.addEventListener('abort', () => {
        cancelled = true;
      });
      opts.onSteer?.((m) => {
        steerSeen.push(m);
        return true;
      });
      void (async () => {
        await opts.store.createSession({ sessionId: SESSION_ID, worktree: WORKTREE, model: 'm' });
        await opts.onSession?.(SESSION_ID);
        await opts.store.appendEvent(SESSION_ID, EVENT_ONE);
        opts.onPermissionRequest?.(PERMISSION_REQUEST, (decision) => {
          permissionAnswers.push(decision);
        });
        resolveStarted();
      })();
      return new Promise<RunResult>((res) => {
        settle = res;
      });
    },
  };
  return {
    backend,
    steerSeen,
    permissionAnswers,
    started,
    get cancelled() {
      return cancelled;
    },
    settle: () => settle(RESULT),
  };
}

/** In-memory Server-side store: ingests frames idempotently, assigns seq to event
 * frames, records appends. */
class RecordingStore implements RunnerFrameStore {
  seq = 0;
  readonly appended: { sessionId: string; event: AgentEvent; seq: number }[] = [];
  private readonly claimed = new Map<string, { seq: number; ts: number } | null>();

  ingestRunnerFrame(sessionId: string, frame: RunnerFrameIngest): Promise<RunnerFrameIngestResult> {
    const key = `${frame.turnId}#${frame.frameSeq}`;
    const prior = this.claimed.get(key);
    if (prior !== undefined) {
      return Promise.resolve(
        prior !== null
          ? { outcome: 'duplicate', seq: prior.seq, ts: prior.ts }
          : { outcome: 'duplicate' },
      );
    }
    if (frame.event !== undefined) {
      this.seq += 1;
      const rec = { seq: this.seq, ts: 1000 + this.seq };
      this.appended.push({ sessionId, event: frame.event, seq: this.seq });
      this.claimed.set(key, rec);
      return Promise.resolve({ outcome: 'accepted', seq: rec.seq, ts: rec.ts });
    }
    this.claimed.set(key, null);
    return Promise.resolve({ outcome: 'accepted' });
  }
}

describe('control socket end-to-end through RunnerServer + FileTailRunnerClient', () => {
  it('routes steer/answerPermission over the socket while result rides the file', async () => {
    const fb = scriptedBackend();
    const store = new RecordingStore();
    const bus = new InMemoryEventBus();
    const published: SequencedEvent[] = [];
    bus.subscribe(SESSION_ID, (e) => published.push(e));

    const client = new FileTailRunnerClient(fb.backend, {
      store,
      bus,
      allocateEventFile: () => join(dir, randomUUID(), 'events.jsonl'),
      allocateControlSocket: () => socketPath(),
      pollMs: 2,
    });

    const permSeen: PermissionRequest[] = [];
    const opts = { store, worktree: WORKTREE, cwd: WORKTREE } as unknown as RunTurnOptions;
    const turn = client.startTurn(opts, {
      onPermissionRequest: (r) => permSeen.push(r),
    });

    await fb.started;
    // Event rode the file: persisted + published (Server-side seq authority).
    await waitFor(() => store.appended.length === 2 && permSeen.length === 1);
    expect(store.appended).toEqual([
      { sessionId: SESSION_ID, event: EVENT_ONE, seq: 1 },
      { sessionId: SESSION_ID, event: PERMISSION_EVENT, seq: 2 },
    ]);
    expect(published).toEqual([
      { seq: 1, ts: 1001, event: EVENT_ONE },
      { seq: 2, ts: 1002, event: PERMISSION_EVENT },
    ]);

    // Control crossed the REAL socket: steer awaits the reply, answerPermission reaches
    // the backend. Wait until the socket client has connected so control routes.
    const steerMsg: SteerMessage = { text: 'via socket' };
    await waitFor(async () => (await turn.steer(steerMsg)) === true, 2000);
    const decision: PermissionDecision = { behavior: 'allow' };
    await turn.answerPermission('tool-1', decision);

    await waitFor(() => fb.steerSeen.length >= 1 && fb.permissionAnswers.length === 1);
    expect(fb.steerSeen).toContainEqual(steerMsg);
    expect(fb.permissionAnswers).toEqual([decision]);

    // Result still resolves off the event file.
    fb.settle();
    await expect(turn.result).resolves.toEqual(RESULT);
  });

  it('routes cancel over the socket; the turn still resolves off the file', async () => {
    const fb = scriptedBackend();
    const store = new RecordingStore();
    const bus = new InMemoryEventBus();

    const client = new FileTailRunnerClient(fb.backend, {
      store,
      bus,
      allocateEventFile: () => join(dir, randomUUID(), 'events.jsonl'),
      allocateControlSocket: () => socketPath(),
      pollMs: 2,
    });

    const opts = { store, worktree: WORKTREE, cwd: WORKTREE } as unknown as RunTurnOptions;
    const turn = client.startTurn(opts, {});

    await fb.started;
    // Wait for the socket client to have connected, then cancel over the socket.
    await waitFor(() => true);
    await waitForCancel(fb, turn);

    fb.settle();
    await expect(turn.result).resolves.toEqual(RESULT);
  });
});

/** Retry `turn.cancel()` until the backend observes the abort — the socket client may
 * still be connecting on the first attempt (cancel is fire-and-forget, so an early one
 * is a no-op rather than an error). */
async function waitForCancel(
  fb: { cancelled: boolean },
  turn: { cancel: () => void },
): Promise<void> {
  const start = Date.now();
  while (!fb.cancelled) {
    turn.cancel();
    if (Date.now() - start > 2000) throw new Error('cancel never reached the backend');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Poll `predicate` (sync or async) until truthy or a timeout. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
}

describe('control attach handshake — D6 snapshot', () => {
  let server: ControlSocketServer | undefined;
  let client: ControlSocketClient | undefined;

  afterEach(async () => {
    client?.close();
    await server?.close();
    server = undefined;
    client = undefined;
  });

  const permission = (toolUseId: string): PermissionRequest => ({
    requestId: `req-${toolUseId}`,
    toolName: 'Bash',
    input: {},
    toolUseId,
  });

  it('returns the live snapshot supplied by the server in the attach ACK', async () => {
    const parked = [permission('tool-a'), permission('tool-b')];
    const path = socketPath();
    server = await serveControl(path, fakeHandlers(), {
      attachSnapshot: () => ({
        protocolVersion: 1,
        runnerInstanceId: 'runner-xyz',
        lastFrameSeq: 42,
        turnStatus: 'running',
        outstandingPermissions: parked,
      }),
    });
    client = await connectControl(path);

    expect(client.snapshot.protocolVersion).toBe(1);
    expect(client.snapshot.runnerInstanceId).toBe('runner-xyz');
    expect(client.snapshot.lastFrameSeq).toBe(42);
    expect(client.snapshot.turnStatus).toBe('running');
    expect(client.snapshot.outstandingPermissions.map((p) => p.toolUseId)).toEqual([
      'tool-a',
      'tool-b',
    ]);
  });

  it('falls back to a running default snapshot when the server supplies no provider', async () => {
    const path = socketPath();
    server = await serveControl(path, fakeHandlers());
    client = await connectControl(path);

    expect(client.snapshot.lastFrameSeq).toBe(0);
    expect(client.snapshot.turnStatus).toBe('running');
    expect(client.snapshot.outstandingPermissions).toEqual([]);
    expect(typeof client.snapshot.protocolVersion).toBe('number');
  });

  it('reflects a settled turn with no outstanding prompts', async () => {
    const path = socketPath();
    server = await serveControl(path, fakeHandlers(), {
      attachSnapshot: () => ({
        protocolVersion: 1,
        lastFrameSeq: 5,
        turnStatus: 'settled',
        outstandingPermissions: [],
      }),
    });
    client = await connectControl(path);

    expect(client.snapshot.turnStatus).toBe('settled');
    expect(client.snapshot.lastFrameSeq).toBe(5);
  });

  it('a provider throw degrades to the default snapshot rather than failing the attach', async () => {
    const path = socketPath();
    server = await serveControl(path, fakeHandlers(), {
      attachSnapshot: () => {
        throw new Error('snapshot boom');
      },
    });
    client = await connectControl(path);

    expect(client.snapshot.turnStatus).toBe('running');
    expect(client.snapshot.lastFrameSeq).toBe(0);
  });

  it('rejects a malformed read-only inspection snapshot before acquiring', async () => {
    const path = socketPath();
    server = await serveControl(path, fakeHandlers(), {
      attachSnapshot: () => ({
        protocolVersion: 1,
        lastFrameSeq: 0,
        turnStatus: 'running',
        outstandingPermissions: [{} as PermissionRequest],
      }),
    });
    await expect(inspectControl(path)).rejects.toThrow(
      'control inspect returned an invalid or incompatible snapshot',
    );
  });
});

/**
 * S6 — steer / cancel / permission survive a Server restart (ADR 0006 D5). The
 * control channel is idempotent under a lost ACK: a command retried with the SAME
 * `commandId` over a NEWER lease is applied exactly once (the Runner's per-commandId
 * journal replays the prior reply), and a still-open permission re-surfaces exactly
 * once across a reattach. (Stale-lease fencing from a dead controller is covered by
 * the "fences commands from a superseded controller lease" case above.)
 */
describe('control idempotency under restart (S6, ADR 0006 D5)', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  const permission = (toolUseId: string): PermissionRequest => ({
    requestId: `req-${toolUseId}`,
    toolName: 'Bash',
    input: {},
    toolUseId,
  });

  it('retries a lost-ACK steer with the SAME command id and applies it exactly once', async () => {
    const handlers = fakeHandlers();
    const path = socketPath();
    const server = await serveControl(path, handlers);
    cleanups.push(() => server.close());

    // The first lease applies the steer, but the socket drops before its ACK is
    // consumed — the Server crashed in the lost-ACK window.
    const raw = createConnection(path);
    await new Promise<void>((resolve) => raw.once('connect', resolve));
    raw.write(
      `${JSON.stringify({ kind: 'attach', turnId: path, controllerId: 'steer-ctrl', mode: 'acquire', protocolVersion: 1 })}\n`,
    );
    await new Promise<void>((resolve) => raw.once('data', () => resolve()));
    const steerMsg: SteerMessage = { text: 'keep going' };
    raw.write(
      `${JSON.stringify({ kind: 'steer', turnId: path, commandId: 'steer-1', leaseEpoch: 1, message: steerMsg })}\n`,
    );
    await waitFor(() => handlers.steerSeen.length === 1);
    raw.destroy();

    // A newer lease resumes the same controller and retries the same command id.
    const retry = await connectControl(path, { controllerId: 'steer-ctrl', resumeLeaseEpoch: 1 });
    cleanups.push(() => retry.close());
    await expect(retry.steer(steerMsg, { commandId: 'steer-1' })).resolves.toBe(true);
    // The journal replayed the prior ACK: the Runner handler ran ONCE, not twice.
    expect(handlers.steerSeen).toEqual([steerMsg]);
  });

  it('retries answerPermission under permission:<turnId>:<toolUseId> and applies it exactly once', async () => {
    const handlers = fakeHandlers();
    const path = socketPath();
    const server = await serveControl(path, handlers);
    cleanups.push(() => server.close());
    // The caller-side idempotency key convention the reattach path uses for a prompt.
    const commandId = `permission:${path}:tool-9`;
    const decision: PermissionDecision = { behavior: 'allow' };

    const raw = createConnection(path);
    await new Promise<void>((resolve) => raw.once('connect', resolve));
    raw.write(
      `${JSON.stringify({ kind: 'attach', turnId: path, controllerId: 'perm-ctrl', mode: 'acquire', protocolVersion: 1 })}\n`,
    );
    await new Promise<void>((resolve) => raw.once('data', () => resolve()));
    raw.write(
      `${JSON.stringify({ kind: 'answer-permission', turnId: path, commandId, leaseEpoch: 1, toolUseId: 'tool-9', decision })}\n`,
    );
    await waitFor(() => handlers.answers.length === 1);
    raw.destroy();

    const retry = await connectControl(path, { controllerId: 'perm-ctrl', resumeLeaseEpoch: 1 });
    cleanups.push(() => retry.close());
    await expect(retry.answerPermission('tool-9', decision, { commandId })).resolves.toEqual({
      commandId,
      applied: true,
    });
    // Idempotent under the same key: the permission was answered exactly once.
    expect(handlers.answers).toEqual([{ toolUseId: 'tool-9', decision }]);
  });

  it('re-surfaces an outstanding permission from the attach snapshot exactly once across a reattach', async () => {
    const handlers = fakeHandlers();
    const path = socketPath();
    // The Runner's live set of parked prompts; answering one clears it at the source.
    const outstanding = new Map<string, PermissionRequest>();
    const parked = permission('tool-p');
    outstanding.set(parked.toolUseId, parked);

    const server = await serveControl(
      path,
      {
        ...handlers,
        answerPermission: (toolUseId, decision) => {
          outstanding.delete(toolUseId);
          return handlers.answerPermission(toolUseId, decision);
        },
      },
      {
        authorizeAcquire: () => true,
        attachSnapshot: () => ({
          protocolVersion: 1,
          lastFrameSeq: 0,
          turnStatus: 'running',
          outstandingPermissions: [...outstanding.values()],
        }),
      },
    );
    cleanups.push(() => server.close());

    // First controller attaches: the parked prompt is re-surfaced from the D6 snapshot.
    const c1 = await connectControl(path, { controllerId: 'ctrl-1' });
    cleanups.push(() => c1.close());
    expect(c1.snapshot.outstandingPermissions.map((p) => p.toolUseId)).toEqual(['tool-p']);
    await c1.answerPermission('tool-p', { behavior: 'allow' });

    // The Server crashes and a NEW controller lease reattaches: the answered prompt is
    // gone from the fresh snapshot, so it never re-surfaces a second time.
    const c2 = await connectControl(path, { controllerId: 'ctrl-2' });
    cleanups.push(() => c2.close());
    expect(c2.snapshot.outstandingPermissions).toEqual([]);
  });
});

describe('durable control journal crash recovery (ADR 0006 D5)', () => {
  it('replays a durably settled reply after restart without repeating its effect', async () => {
    const path = socketPath();
    const journalPath = `${path}.journal`;
    const firstHandlers = fakeHandlers();
    const firstServer = await serveControl(path, firstHandlers, {
      turnId: 'turn-settled',
      authorizeAcquire: () => true,
      journalPath,
    });
    const first = await connectControl(path, { turnId: 'turn-settled' });
    await expect(
      first.steer({ text: 'persist me' }, { commandId: 'steer-settled-1' }),
    ).resolves.toBe(true);
    first.close();
    await firstServer.close();

    const replayed: SteerMessage[] = [];
    const restarted = await serveControl(
      path,
      { ...fakeHandlers(), steer: (message) => replayed.push(message) > 0 },
      { turnId: 'turn-settled', authorizeAcquire: () => true, journalPath },
    );
    try {
      const retry = await connectControl(path, { turnId: 'turn-settled' });
      await expect(
        retry.steer({ text: 'persist me' }, { commandId: 'steer-settled-1' }),
      ).resolves.toBe(true);
      await expect(
        retry.steer({ text: 'different' }, { commandId: 'steer-settled-1' }),
      ).rejects.toMatchObject({ reason: 'command-conflict' });
      retry.close();
    } finally {
      await restarted.close();
    }
    expect(firstHandlers.steerSeen).toEqual([{ text: 'persist me' }]);
    expect(replayed).toEqual([]);
  });

  it('reports an effect/journal crash window as ambiguous without replaying the effect', async () => {
    const path = socketPath();
    const journalPath = `${path}.journal`;
    const effectPath = join(dir, 'steer-effects.jsonl');
    // Resolve the Vitest CLI through the module graph, not `process.cwd()`:
    // in an npm-workspaces session worktree the dependency tree is hoisted to
    // the repo root, so `<cwd>/node_modules/vitest` does not exist and the child
    // would die with MODULE_NOT_FOUND before it ever reaches the crash scenario.
    // `vitest.mjs` is the package's bin and is not in its exports map, so go via
    // `package.json`, which is.
    const vitestPath = fileURLToPath(
      new URL('vitest.mjs', import.meta.resolve('vitest/package.json')),
    );
    let stderr = '';
    const child = spawn(
      process.execPath,
      [
        vitestPath,
        'run',
        'packages/session/src/runner-control-crash-child.test.ts',
        '--maxWorkers=1',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          VERITY_CONTROL_CRASH_SOCKET: path,
          VERITY_CONTROL_CRASH_JOURNAL: journalPath,
          VERITY_CONTROL_CRASH_EFFECT: effectPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_384);
    });
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        child.once('error', rejectReady);
        child.once('exit', (code, signal) =>
          rejectReady(new Error(`crash fixture exited before ready: ${code}/${signal}\n${stderr}`)),
        );
        child.stdout.on('data', (chunk: Buffer) => {
          if (chunk.toString('utf8').includes('CONTROL_CRASH_READY')) resolveReady();
        });
      });
      const first = await connectControl(path, { turnId: 'turn-crash' });
      const unknown = first.steer({ text: 'apply once' }, { commandId: 'steer-crash-1' });
      const unknownAssertion = expect(unknown).rejects.toMatchObject({
        commandId: 'steer-crash-1',
      });
      await new Promise<void>((resolveExit, rejectExit) => {
        child.once('error', rejectExit);
        child.once('exit', (code, signal) => {
          // Vitest runs the fixture in a forked worker. SIGKILL terminates that
          // worker; the small Vitest coordinator then exits 1 after reporting the
          // expected unexpected-worker death.
          if (code === 1 && signal === null && stderr.includes('Worker exited unexpectedly')) {
            resolveExit();
          } else {
            rejectExit(
              new Error(`crash fixture exited unexpectedly: ${code}/${signal}\n${stderr}`),
            );
          }
        });
      });
      await unknownAssertion;
      first.close();
      // Model a second crash during the following `settled` append. Recovery must
      // discard only this torn suffix and retain the complete `received` record.
      await appendFile(journalPath, '{"protocolVersion":1');

      const replayed: SteerMessage[] = [];
      const restarted = await serveControl(
        path,
        { ...fakeHandlers(), steer: (message) => replayed.push(message) > 0 },
        { turnId: 'turn-crash', authorizeAcquire: () => true, journalPath },
      );
      try {
        const retry = await connectControl(path, { turnId: 'turn-crash' });
        await expect(
          retry.steer({ text: 'apply once' }, { commandId: 'steer-crash-1' }),
        ).rejects.toEqual(
          expect.objectContaining<Partial<ControlCommandRejectedError>>({
            commandId: 'steer-crash-1',
            reason: 'ambiguous',
          }),
        );
        retry.close();
      } finally {
        await restarted.close();
      }
      expect(replayed).toEqual([]);
      expect((await readFile(effectPath, 'utf8')).trim().split('\n')).toEqual(['apply once']);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 20_000);
});
