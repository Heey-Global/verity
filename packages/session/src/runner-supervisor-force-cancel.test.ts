import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Backend } from './backend.js';
import { InMemoryEventBus } from './bus.js';
import type { RunnerFrameStore } from './file-tail-runner-client.js';
import { SupervisorRunnerClient } from './runner-supervisor-client.js';

let dir: string;

const servers: Server[] = [];

const sockets = new Set<Socket>();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'verity-supervisor-client-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((r) => server.close(() => r()))),
  );
  await rm(dir, { recursive: true, force: true });
});

const state = (status: 'claimed' | 'running' | 'settled' = 'running') => ({
  protocolVersion: 1,
  turnId: 'turn-1',
  startCommandId: 'start-1',
  runnerInstanceId: 'runner-1',
  status,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

/**
 * A supervisor that answers each request from `replies`, keyed by the request's
 * `kind`, and records everything it was asked. The fixtures above answer every
 * request with one canned frame, which cannot express the sequences these tests
 * turn on — a `cancel-turn` that is refused while the following `get-turn`
 * succeeds, or a `get-turn` that reports a different turn than the one just
 * started.
 */
async function serveByKind(
  path: string,
  replies: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  await mkdir(join(path, '..'), { recursive: true });
  const requests: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    // Several callers deliberately time out and destroy their connection before
    // this stand-in writes its canned reply. That close is the behavior under
    // test, not an unhandled mock-server failure.
    socket.on('error', () => undefined);
    socket.once('data', (data: Buffer) => {
      const request = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      requests.push(request);
      const reply = replies[String(request.kind)];
      socket.end(
        `${JSON.stringify(
          typeof reply === 'function'
            ? (reply as (r: Record<string, unknown>) => unknown)(request)
            : reply,
        )}\n`,
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return requests;
}

describe('SupervisorRunnerClient.forceCancel', () => {
  const backend = { runnerSupervisorBackend: 'codex-acp' } as Backend;
  const store = {
    ingestRunnerFrame: async () => ({ outcome: 'accepted' as const }),
  } as RunnerFrameStore;

  /** Reattach to a turn whose artifacts never appear, so the handle stays live and
   * the only thing under test is how `forceCancel` talks to the supervisor. */
  function reattach(runtime: string, turnId = 'turn-1') {
    const client = new SupervisorRunnerClient(backend, {
      securityPreflight: false,
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      timeoutMs: 200,
    });
    return client.attach(
      {
        turnId,
        sessionId: 'session-1',
        eventFilePath: join(runtime, 'turns', turnId, 'events.jsonl'),
        controlSocketPath: join(runtime, 'turns', turnId, 'control.sock'),
      },
      {},
    );
  }

  it('reports a supervisor-confirmed kill and settles the local handle', async () => {
    const runtime = join(dir, 'force-cancel-ok');
    const requests = await serveByKind(join(runtime, 'supervisor.sock'), {
      'cancel-turn': { ok: true, outcome: 'cancelled' },
    });
    const turn = reattach(runtime);

    await expect(turn.forceCancel?.()).resolves.toBe(true);
    expect(requests).toEqual([{ protocolVersion: 1, kind: 'cancel-turn', turnId: 'turn-1' }]);
    await expect(turn.result).resolves.toEqual({
      sessionId: 'session-1',
      exitCode: 143,
      stderr: '',
      aborted: true,
    });
  });

  // `terminal` means the supervisor found the turn already over. The boolean is a
  // termination CERTIFICATE, not a report that this call delivered the kill — and a
  // worker that was already gone certifies just as well as one killed here. Returning
  // false would tell the ownership barrier the worker might still hold the worktree.
  it('confirms termination when the turn was already terminal', async () => {
    const runtime = join(dir, 'force-cancel-terminal');
    await serveByKind(join(runtime, 'supervisor.sock'), {
      'cancel-turn': { ok: true, outcome: 'terminal' },
    });
    const turn = reattach(runtime);

    await expect(turn.forceCancel?.()).resolves.toBe(true);
    await expect(turn.result).resolves.toMatchObject({ aborted: true });
  });

  // A cancel whose response was lost may still have killed the worker. Settling
  // locally on that guess would strand a live agent, so it only settles when a
  // follow-up state read proves the turn terminal.
  it('accepts a lost cancel response once a follow-up state read proves the turn settled', async () => {
    const runtime = join(dir, 'force-cancel-lost-response');
    const requests = await serveByKind(join(runtime, 'supervisor.sock'), {
      'cancel-turn': { ok: false, error: 'connection reset before the reply' },
      'get-turn': { ok: true, state: state('settled') },
    });
    const turn = reattach(runtime);

    await expect(turn.forceCancel?.()).resolves.toBe(true);
    expect(requests.map((request) => request.kind)).toEqual(['cancel-turn', 'get-turn']);
    await expect(turn.result).resolves.toMatchObject({ aborted: true });
  });

  it('keeps the original failure when the follow-up state read does not prove settlement', async () => {
    const runtime = join(dir, 'force-cancel-still-running');
    await serveByKind(join(runtime, 'supervisor.sock'), {
      'cancel-turn': { ok: false, error: 'supervisor is busy' },
      'get-turn': { ok: true, state: state('running') },
    });
    const turn = reattach(runtime);

    await expect(turn.forceCancel?.()).rejects.toThrow(
      'runner supervisor rejected request: supervisor is busy',
    );
    await expect(turn.forceCancel?.()).rejects.toThrow('supervisor is busy');
    await turn.forceCancel?.().catch(() => undefined);
    // Never settled locally: the agent may still be running.
    await expect(
      Promise.race([
        turn.result.then(() => 'settled'),
        new Promise((resolve) => setTimeout(() => resolve('live'), 50)),
      ]),
    ).resolves.toBe('live');
  });

  it('refuses an outcome the supervisor is not allowed to report', async () => {
    const runtime = join(dir, 'force-cancel-bad-outcome');
    await serveByKind(join(runtime, 'supervisor.sock'), {
      'cancel-turn': { ok: true, outcome: 'maybe' },
      'get-turn': { ok: true, state: state('running') },
    });
    const turn = reattach(runtime);

    await expect(turn.forceCancel?.()).rejects.toThrow(
      'runner supervisor returned an invalid cancel outcome',
    );
  });

  // A turn id that could not have come from this Server never reaches the wire: it is
  // interpolated into the supervisor's own turn paths. The wrapper is simply not
  // installed, so the cancel is NOT dropped — it falls through to the transport's own
  // force-cancel, which really does abort the handle. Both halves are asserted here,
  // because "no request was sent" on its own would also describe a silent no-op that
  // answers `true` while a turn keeps running.
  it('never sends an unsafe turn id to the supervisor, and still aborts locally', async () => {
    const runtime = join(dir, 'force-cancel-unsafe-id');
    const requests = await serveByKind(join(runtime, 'supervisor.sock'), {
      'cancel-turn': { ok: true, outcome: 'cancelled' },
    });
    const turn = reattach(runtime, '../escape');

    await expect(turn.forceCancel?.()).resolves.toBe(false);
    expect(requests).toEqual([]);
    // An unsafe id cannot be sent or certified as cancelled by the supervisor.
    await expect(turn.result).resolves.toEqual({
      sessionId: 'session-1',
      exitCode: 143,
      stderr: '',
      aborted: true,
    });
  });
});
