import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Backend } from './backend.js';
import { InMemoryEventBus } from './bus.js';
import type { RunnerFrameStore } from './file-tail-runner-client.js';
import { stampFrame } from './runner-transport.js';
import {
  DEFAULT_SUPERVISOR_REQUEST_TIMEOUT_MS,
  MAX_SUPERVISOR_REQUEST_BYTES,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  requestRunnerSupervisor,
  runSupervisorTrustedCli,
  trustedCliDispatchMessage,
  TrustedCliDispatchError,
  RunnerWorkerStartFailure,
  START_TURN_ARTIFACT_TIMEOUT_MS,
  START_TURN_MISSING_STATE_MIN_MS,
  START_TURN_RESULT_TIMEOUT_MS,
  SupervisorRunnerClient,
  SupervisorRunnerRecovery,
  type SupervisorStartTelemetry,
} from './runner-supervisor-client.js';

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

async function serve(path: string, reply: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.once('data', () => socket.end(`${JSON.stringify(reply)}\n`));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
}

const state = (status: 'claimed' | 'running' | 'settled' = 'running') => ({
  protocolVersion: 1,
  turnId: 'turn-1',
  startCommandId: 'start-1',
  runnerInstanceId: 'runner-1',
  status,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

describe('requestRunnerSupervisor', () => {
  it('gets and strictly validates a turn over the Unix socket', async () => {
    const socket = join(dir, 'supervisor.sock');
    await serve(socket, { ok: true, state: state() });
    await expect(
      requestRunnerSupervisor(socket, { kind: 'get-turn', turnId: 'turn-1' }),
    ).resolves.toMatchObject({
      ok: true,
      state: { turnId: 'turn-1', status: 'running' },
    });
  });

  // ADR 0006 D9: the request is read by a supervisor that shipped inside the
  // Sandbox image, and every supervisor already deployed compares the version for
  // equality. Writing this Server's own version would make the first bump an
  // outage for every running Sandbox — the failure the supported range exists to
  // prevent, reached from the sending side.
  it('writes requests at the oldest dialect this Server supports', async () => {
    const path = join(dir, 'dialect.sock');
    const frames: string[] = [];
    await mkdir(join(path, '..'), { recursive: true });
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.once('data', (chunk: Buffer) => {
        frames.push(chunk.toString('utf8'));
        socket.end(`${JSON.stringify({ ok: true, protocolVersion: 1, runnerInstanceId: 'r' })}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    await requestRunnerSupervisor(path, { kind: 'status' });
    expect((JSON.parse(frames[0] ?? '{}') as { protocolVersion?: unknown }).protocolVersion).toBe(
      MIN_SUPPORTED_PROTOCOL_VERSION,
    );
  });

  // A refusal used to reach the operator as an unexplained failed run: the
  // supervisor sends `{ ok: false, error }`, and the reason was dropped here.
  it('carries the supervisor’s reason into the rejection', async () => {
    const socket = join(dir, 'refused.sock');
    await serve(socket, { ok: false, error: 'turn is not accepting requests' });
    await expect(requestRunnerSupervisor(socket, { kind: 'status' })).rejects.toThrow(
      /rejected request: turn is not accepting requests/u,
    );
  });

  it('still reports a bare rejection when the supervisor sends no reason', async () => {
    const socket = join(dir, 'refused-bare.sock');
    await serve(socket, { ok: false });
    await expect(requestRunnerSupervisor(socket, { kind: 'status' })).rejects.toThrow(
      /rejected request$/u,
    );
  });

  it('names the request kind when one times out', async () => {
    const socket = join(dir, 'named-timeout.sock');
    const server = createServer((peer) => {
      sockets.add(peer);
      peer.once('close', () => sockets.delete(peer));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    await expect(requestRunnerSupervisor(socket, { kind: 'status' }, 10)).rejects.toThrow(
      /timed out: status/u,
    );
  });

  // Regression: the old default was one second, so a busy supervisor could finish
  // the work after this Server had already reported the request as failed.
  it('waits out a supervisor response slower than the retired one-second default', async () => {
    const socket = join(dir, 'slow-supervisor.sock');
    const server = createServer((peer) => {
      sockets.add(peer);
      peer.once('close', () => sockets.delete(peer));
      peer.once('data', () => {
        setTimeout(() => peer.end(`${JSON.stringify({ ok: true })}\n`), 1_200);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socket, resolve));

    await expect(requestRunnerSupervisor(socket, { kind: 'status' })).resolves.toMatchObject({
      ok: true,
    });
  });

  it('keeps slow start and artifact work separate from control-request deadlines', () => {
    expect(DEFAULT_SUPERVISOR_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(START_TURN_ARTIFACT_TIMEOUT_MS).toBe(60_000);
    expect(START_TURN_RESULT_TIMEOUT_MS).toBe(120_000);
  });

  it('keeps the request socket open until a delayed supervisor response arrives', async () => {
    const socket = join(dir, 'delayed.sock');
    let clientEndedBeforeResponse = false;
    const server = createServer((peer) => {
      sockets.add(peer);
      peer.once('close', () => sockets.delete(peer));
      peer.once('end', () => {
        clientEndedBeforeResponse = true;
      });
      peer.once('data', () => {
        setTimeout(() => {
          peer.end(`${JSON.stringify({ ok: true, clientEndedBeforeResponse })}\n`);
        }, 10);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socket, resolve));

    await expect(requestRunnerSupervisor(socket, { kind: 'status' })).resolves.toMatchObject({
      ok: true,
      clientEndedBeforeResponse: false,
    });
  });

  // Two phone photos are ~6 MiB of base64 in one start-turn frame. The supervisor
  // refuses at 4 MiB and closes mid-write, so the operator saw `write EPIPE` — a
  // message naming neither the size nor the attachments that caused it, and one
  // that reads like a dead agent process rather than a payload that is too big.
  it('refuses an over-cap request before writing it, naming size and attachments', async () => {
    const socket = join(dir, 'oversize.sock');
    let framesSeen = 0;
    await mkdir(join(socket, '..'), { recursive: true });
    const server = createServer((peer) => {
      sockets.add(peer);
      peer.once('close', () => sockets.delete(peer));
      peer.once('data', () => {
        framesSeen += 1;
        peer.end(`${JSON.stringify({ ok: true })}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socket, resolve));

    await expect(
      requestRunnerSupervisor(socket, {
        kind: 'start-turn',
        attachments: [{ data: 'A'.repeat(MAX_SUPERVISOR_REQUEST_BYTES) }, { data: 'B' }],
      }),
    ).rejects.toThrow(/request too large: 4\.0 MiB exceeds the 4\.0 MiB limit — .*\(2 attached\)/u);
    // Not one byte on the wire: the refusal must not depend on reaching a
    // supervisor, or a same-size frame would still race its own write.
    expect(framesSeen).toBe(0);
  });

  // The refusal and the Server's remaining write race, and the write loses first:
  // reporting its EPIPE discards the frame that already explains the failure.
  it('prefers a buffered supervisor refusal over the transport error that follows', async () => {
    const socket = join(dir, 'refused-then-reset.sock');
    await mkdir(join(socket, '..'), { recursive: true });
    const server = createServer((peer) => {
      sockets.add(peer);
      peer.once('close', () => sockets.delete(peer));
      peer.once('data', () => {
        // Reset only once the refusal is flushed: `destroy()` drops whatever is
        // still buffered, and a test that sometimes loses the frame it is about
        // would pass for the reason it exists to rule out.
        peer.write(
          `${JSON.stringify({ ok: false, error: 'supervisor frame too large' })}\n`,
          () => {
            // The supervisor's own `socket.destroy()`, arriving while the client is
            // still streaming: the rest of that write then fails with EPIPE.
            peer.destroy();
          },
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socket, resolve));

    // Just under the cap, so the pre-flight check lets it through and the write is
    // large enough to still be in flight when the refusal lands.
    await expect(
      requestRunnerSupervisor(socket, {
        kind: 'start-turn',
        prompt: 'x'.repeat(MAX_SUPERVISOR_REQUEST_BYTES - 1024),
      }),
    ).rejects.toThrow(/rejected request: supervisor frame too large/u);
  });

  it('rejects malformed and incompatible state', async () => {
    const socket = join(dir, 'runners', 'project-1', 'supervisor.sock');
    await serve(socket, { ok: true, state: { ...state(), protocolVersion: 99 } });
    const recovery = new SupervisorRunnerRecovery({
      dataVolumeRoot: dir,
      getSession: async () => ({ projectId: 'project-1' }),
    });
    await expect(
      recovery.discover({ sessionId: 's', turnId: 'turn-1', startCommandId: 'start-1' }),
    ).resolves.toEqual({ status: 'uncertain' });
  });

  it('bounds timeout and response size', async () => {
    const timeoutSocket = join(dir, 'timeout.sock');
    const hanging = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    servers.push(hanging);
    await new Promise<void>((resolve) => hanging.listen(timeoutSocket, resolve));
    await expect(requestRunnerSupervisor(timeoutSocket, { kind: 'status' }, 10)).rejects.toThrow(
      'timed out',
    );

    const largeSocket = join(dir, 'large.sock');
    const large = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.once('data', () => socket.end('x'.repeat(64 * 1024 + 1)));
    });
    servers.push(large);
    await new Promise<void>((resolve) => large.listen(largeSocket, resolve));
    await expect(requestRunnerSupervisor(largeSocket, { kind: 'status' })).rejects.toThrow(
      'too large',
    );
  });
});

describe('SupervisorRunnerClient', () => {
  it('runs an out-of-band trusted CLI call through the project supervisor', async () => {
    const runtime = join(dir, 'gateway-trusted-cli-runtime');
    const socket = join(runtime, 'supervisor.sock');
    await mkdir(runtime, { recursive: true });
    let received: Record<string, unknown> | undefined;
    const server = createServer((peer) => {
      sockets.add(peer);
      peer.once('close', () => sockets.delete(peer));
      peer.once('data', (data) => {
        received = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        peer.end(
          `${JSON.stringify({ ok: true, exitCode: 0, stdout: 'done', stderr: '', truncated: true })}\n`,
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socket, resolve));

    await expect(
      runSupervisorTrustedCli(runtime, {
        turnId: 'turn-1',
        secrets: [
          { secretAlias: 'DEPLOY_KEY', env: 'DEPLOY_KEY', injection: 'file', secret: 'marker' },
        ],
        command: ['/usr/bin/deploy', '--key=/run/verity-runner/secrets/DEPLOY_KEY'],
      }),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: 'done',
      stderr: '',
      truncated: true,
    });
    expect(received).toEqual({
      protocolVersion: 1,
      kind: 'run-trusted-cli',
      turnId: 'turn-1',
      secrets: [
        { secretAlias: 'DEPLOY_KEY', env: 'DEPLOY_KEY', injection: 'file', secret: 'marker' },
      ],
      command: ['/usr/bin/deploy', '--key=/run/verity-runner/secrets/DEPLOY_KEY'],
    });
  });

  const backend = { runnerSupervisorBackend: 'codex-acp' } as Backend;
  const store = {
    ingestRunnerFrame: async () => ({ outcome: 'accepted' as const }),
  } as RunnerFrameStore;

  it('sends the durable turn identity and runtime fields to start-turn', async () => {
    const runtime = join(dir, 'runtime');
    const socket = join(runtime, 'supervisor.sock');
    let request: Record<string, unknown> | undefined;
    await mkdir(runtime, { recursive: true });
    const server = createServer((peer) => {
      sockets.add(peer);
      peer.once('close', () => sockets.delete(peer));
      peer.once('data', (data) => {
        request = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        peer.end(`${JSON.stringify({ ok: true, outcome: 'ambiguous' })}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
    });
    const turn = client.startTurn(
      {
        store: {} as never,
        worktree: '/work/project',
        cwd: '/work/project/subdir',
        prompt: 'hello',
        model: 'claude-sonnet',
        storeSessionId: 'session-1',
        turnId: 'turn-1',
        startCommandId: 'start-1',
        steerable: true,
        appendSystemPrompt: 'policy',
        resumeSessionId: 'claude-session-1',
        permissionControl: true,
        permissionMode: 'plan',
        allowedTools: ['Read', 'Bash(git *)'],
        disallowedTools: ['WebFetch'],
        timeoutMs: 30_000,
      },
      {},
    );
    await expect(turn.result).rejects.toThrow('invalid start outcome');
    expect(request).toMatchObject({
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-1',
      startCommandId: 'start-1',
      sessionId: 'session-1',
      backend: 'codex-acp',
      worktree: '/work/project',
      cwd: '/work/project/subdir',
      prompt: 'hello',
      model: 'claude-sonnet',
      steerable: true,
      appendSystemPrompt: 'policy',
      resumeSessionId: 'claude-session-1',
      permissionControl: true,
      permissionMode: 'plan',
      allowedTools: ['Read', 'Bash(git *)'],
      disallowedTools: ['WebFetch'],
      timeoutMs: 30_000,
    });
  });

  async function captureStartRequest(
    runtimeName: string,
    opts: Record<string, unknown>,
    overrides: { backend?: Backend; clientOptions?: Record<string, unknown> } = {},
  ): Promise<Record<string, unknown> | undefined> {
    const runtime = join(dir, runtimeName);
    const socket = join(runtime, 'supervisor.sock');
    let request: Record<string, unknown> | undefined;
    await mkdir(runtime, { recursive: true });
    const server = createServer((peer) => {
      sockets.add(peer);
      peer.once('close', () => sockets.delete(peer));
      peer.once('data', (data) => {
        request = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        peer.end(`${JSON.stringify({ ok: true, outcome: 'ambiguous' })}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    const client = new SupervisorRunnerClient(overrides.backend ?? backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      ...overrides.clientOptions,
    });
    const turn = client.startTurn(
      {
        store: {} as never,
        worktree: '/work/project',
        cwd: '/work/project',
        storeSessionId: 'session-1',
        turnId: 'turn-1',
        startCommandId: 'start-1',
        ...opts,
      },
      {},
    );
    // 'ambiguous' is not a valid start outcome; the launch rejects AFTER sending the
    // request, which is exactly what we captured above.
    await expect(turn.result).rejects.toThrow('invalid start outcome');
    return request;
  }

  it('carries image attachments over start-turn without tripping the parity guard', async () => {
    const request = await captureStartRequest('attach-runtime', {
      prompt: 'look',
      attachments: [{ kind: 'image', mediaType: 'image/png', data: 'aGk=' }],
    });
    expect(request).toMatchObject({
      kind: 'start-turn',
      prompt: 'look',
      attachments: [{ kind: 'image', mediaType: 'image/png', data: 'aGk=' }],
    });
  });

  it('omits attachments entirely for a turn without any (unchanged wire shape)', async () => {
    const request = await captureStartRequest('no-attach-runtime', { prompt: 'hello' });
    expect(request).not.toHaveProperty('attachments');
  });

  it('carries a per-turn MCP gateway bearer for an ACP turn', async () => {
    const issued: string[] = [];
    const request = await captureStartRequest(
      'acp-gateway-runtime',
      { prompt: 'hello' },
      {
        backend: { runnerSupervisorBackend: 'claude-acp' } as Backend,
        clientOptions: {
          mcpGatewayTokens: {
            issue: (turnId: string) => {
              issued.push(turnId);
              return 'gateway-token-1';
            },
            release: () => undefined,
          },
        },
      },
    );
    expect(issued).toEqual(['turn-1']);
    expect(request).toMatchObject({
      backend: 'claude-acp',
      trustedCliExecution: true,
      mcpGatewayToken: 'gateway-token-1',
    });
  });

  it('mints no bearer for an OpenCode ACP turn', async () => {
    const issued: string[] = [];
    const request = await captureStartRequest(
      'opencode-acp-gateway-runtime',
      { prompt: 'hello' },
      {
        backend: { runnerSupervisorBackend: 'opencode-acp' } as Backend,
        clientOptions: {
          mcpGatewayTokens: {
            issue: (turnId: string) => {
              issued.push(turnId);
              return 'gateway-token-1';
            },
            release: () => undefined,
          },
        },
      },
    );
    // This is where the decision is actually enforced — every gate downstream is a
    // re-check. Minting here would not quietly widen OpenCode's authority, it would
    // BREAK it: the supervisor answers `invalid mcpGatewayToken` for a bearer on a
    // backend outside `ACP_WORKER_BACKENDS`, so every OpenCode turn would fail at
    // start-turn. Both directions of the invariant fail here first (ADR 0014 D1,
    // ADR 0012 Amendment 4).
    expect(issued).toEqual([]);
    expect(request).not.toHaveProperty('mcpGatewayToken');
    expect(request).toMatchObject({ backend: 'opencode-acp', trustedCliExecution: false });
  });

  // Retiring is keyed on the bearer this start attempt minted, never on its turn id:
  // a second attempt for one turn would otherwise cut off a worker still using the
  // first attempt's bearer.
  it('retires the bearer it minted once the turn settles', async () => {
    const released: string[] = [];
    let minted = 0;
    await captureStartRequest(
      'acp-gateway-release-runtime',
      { prompt: 'hello' },
      {
        backend: { runnerSupervisorBackend: 'claude-acp' } as Backend,
        clientOptions: {
          mcpGatewayTokens: {
            issue: () => `gateway-token-${(minted += 1)}`,
            release: (token: string) => released.push(token),
          },
        },
      },
    );
    // captureStartRequest settles the turn by rejecting the launch — a failed turn has
    // to retire its bearer just as a successful one does.
    expect(released).toEqual(['gateway-token-1']);
  });

  it('restores Codex rollout state before routing resume through start-turn', async () => {
    const runtime = join(dir, 'codex-runtime');
    const socket = join(runtime, 'supervisor.sock');
    let request: Record<string, unknown> | undefined;
    await mkdir(runtime, { recursive: true });
    const server = createServer((peer) => {
      sockets.add(peer);
      peer.once('close', () => sockets.delete(peer));
      peer.once('data', (data) => {
        request = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        peer.end(`${JSON.stringify({ ok: true, outcome: 'ambiguous' })}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    const transcript = {
      restoreForResume: vi.fn(async () => 0),
      tail: vi.fn(async () => undefined),
    };
    const client = new SupervisorRunnerClient({ runnerSupervisorBackend: 'codex-acp' } as Backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      transcript,
    });
    const turn = client.startTurn(
      {
        store: {} as never,
        worktree: '/work/project',
        cwd: '/work/project',
        prompt: 'hello',
        model: 'codex/default',
        resumeSessionId: 'codex-thread-1',
        storeSessionId: 'session-1',
        turnId: 'turn-1',
        startCommandId: 'start-1',
      },
      {},
    );
    await expect(turn.result).rejects.toThrow('invalid start outcome');
    expect(request).toMatchObject({
      backend: 'codex-acp',
      model: 'codex/default',
    });
    expect(transcript.restoreForResume).toHaveBeenCalledWith(
      'codex-thread-1',
      '/work/project',
      'session-1',
    );
    expect(transcript.tail).not.toHaveBeenCalled();
  });

  it('fails closed before launch when worker option parity is incomplete', async () => {
    // Steering and permission prompts need a mid-turn round trip the worker cannot
    // serve yet; dropping either silently would be a real behavior loss.
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: join(dir, 'missing'),
      store,
      bus: new InMemoryEventBus(),
    });
    const turn = client.startTurn(
      {
        store: {} as never,
        worktree: '/work/project',
        cwd: '/work/project',
        storeSessionId: 'session-1',
        turnId: 'turn-1',
        startCommandId: 'start-1',
        onSteer: () => {},
      },
      {},
    );
    await expect(turn.result).rejects.toThrow('not yet supported');
  });

  it('keeps the Server environment out of the Sandbox, forwarding only session context', async () => {
    // The worker spawns through the agent broker inside the Sandbox, so the Server's
    // own environment must not cross — only Verity's per-turn runtime context, which
    // in-Sandbox helpers such as verity-code-review read.
    const request = await captureStartRequest('env-boundary', {
      store: {},
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'hello',
      storeSessionId: 'session-1',
      turnId: 'turn-1',
      startCommandId: 'start-1',
      env: {
        SECRET: 'must-not-cross',
        PATH: '/usr/bin',
        VERITY_SESSION_BACKEND: 'claude',
        VERITY_SESSION_MODEL: 'claude-sonnet',
      },
    });
    expect(request?.sessionEnv).toEqual({
      VERITY_SESSION_BACKEND: 'claude',
      VERITY_SESSION_MODEL: 'claude-sonnet',
    });
    expect(JSON.stringify(request)).not.toContain('must-not-cross');
    expect(JSON.stringify(request)).not.toContain('/usr/bin');
  });

  it('accepts a turn that settles before its control socket becomes observable', async () => {
    const runtime = join(dir, 'fast-runtime');
    const turnDir = join(runtime, 'turns', 'turn-1');
    await mkdir(turnDir, { recursive: true });
    const frames = [
      stampFrame(
        { kind: 'session', id: 'session-1' },
        { turnId: 'turn-1', runnerInstanceId: 'runner-1', frameSeq: 1 },
      ),
      stampFrame(
        {
          kind: 'result',
          result: { sessionId: 'session-1', exitCode: 0, stderr: '', aborted: false },
        },
        { turnId: 'turn-1', runnerInstanceId: 'runner-1', frameSeq: 2 },
      ),
    ];
    await writeFile(
      join(turnDir, 'events.jsonl'),
      `${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`,
    );
    const server = createServer((peer) => {
      sockets.add(peer);
      peer.once('close', () => sockets.delete(peer));
      peer.once('data', (data) => {
        const request = JSON.parse(data.toString('utf8')) as { kind: string };
        peer.end(
          `${JSON.stringify({
            ok: true,
            ...(request.kind === 'start-turn' ? { outcome: 'created' } : {}),
            state: state(request.kind === 'start-turn' ? 'running' : 'settled'),
          })}\n`,
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(join(runtime, 'supervisor.sock'), resolve));
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
    });
    const optsOnSession = vi.fn();
    const hookOnSession = vi.fn();
    const turn = client.startTurn(
      {
        store: {} as never,
        worktree: '/work/project',
        cwd: '/work/project',
        storeSessionId: 'session-1',
        turnId: 'turn-1',
        startCommandId: 'start-1',
        onSession: optsOnSession,
      },
      { onSession: hookOnSession },
    );
    await expect(turn.result).resolves.toMatchObject({ exitCode: 0, sessionId: 'session-1' });
    expect(optsOnSession).toHaveBeenCalledWith('session-1');
    expect(hookOnSession).toHaveBeenCalledWith('session-1');
  });

  it('rejects a settled worker failure that produced no event stream', async () => {
    const runtime = join(dir, 'failed-runtime');
    await serve(join(runtime, 'supervisor.sock'), {
      ok: true,
      outcome: 'terminal',
      state: {
        ...state('settled'),
        workerExitCode: 1,
        workerError: 'connector rejected the worker launch',
      },
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
    });
    const turn = client.startTurn(
      {
        store: {} as never,
        worktree: '/work/project',
        cwd: '/work/project',
        storeSessionId: 'session-1',
        turnId: 'turn-1',
        startCommandId: 'start-1',
      },
      {},
    );
    await expect(turn.result).rejects.toThrow(
      'runner worker failed before creating its event stream: connector rejected the worker launch',
    );
  });

  it('falls back to the worker exit code when early failure has no stderr', async () => {
    const runtime = join(dir, 'failed-without-stderr-runtime');
    await serve(join(runtime, 'supervisor.sock'), {
      ok: true,
      outcome: 'terminal',
      state: { ...state('settled'), workerExitCode: 23 },
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
    });
    const turn = client.startTurn(
      {
        store: {} as never,
        worktree: '/work/project',
        cwd: '/work/project',
        storeSessionId: 'session-1',
        turnId: 'turn-1',
        startCommandId: 'start-1',
      },
      {},
    );
    await expect(turn.result).rejects.toThrow(
      'runner worker failed before creating its event stream: worker exited with code 23',
    );
  });

  it('reports a missing stream after successful worker exit as a stream failure', async () => {
    const runtime = join(dir, 'successful-without-stream-runtime');
    await serve(join(runtime, 'supervisor.sock'), {
      ok: true,
      outcome: 'terminal',
      state: { ...state('settled'), workerExitCode: 0, workerSignal: null },
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
    });
    const turn = client.startTurn(
      {
        store: {} as never,
        worktree: '/work/project',
        cwd: '/work/project',
        storeSessionId: 'session-1',
        turnId: 'turn-1',
        startCommandId: 'start-1',
      },
      {},
    );
    await expect(turn.result).rejects.toThrow(
      'settled runner event stream is missing after the worker exited successfully',
    );
  });

  it('reports an inaccessible event stream with its filesystem error code', async () => {
    const runtime = join(dir, 'inaccessible-runtime');
    const turnDir = join(runtime, 'turns', 'turn-1');
    await mkdir(turnDir, { recursive: true });
    const eventPath = join(turnDir, 'events.jsonl');
    await writeFile(eventPath, '{}\n');
    await chmod(eventPath, 0o000);
    await serve(join(runtime, 'supervisor.sock'), {
      ok: true,
      outcome: 'terminal',
      state: { ...state('settled'), workerExitCode: 1 },
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
    });
    const turn = client.startTurn(
      {
        store: {} as never,
        worktree: '/work/project',
        cwd: '/work/project',
        storeSessionId: 'session-1',
        turnId: 'turn-1',
        startCommandId: 'start-1',
      },
      {},
    );
    await expect(turn.result).rejects.toThrow(
      /settled runner event stream is not accessible \((EACCES|EPERM)\)/,
    );
    await chmod(eventPath, 0o660);
  });

  it('rejects an oversized workerError in supervisor state', async () => {
    const runtime = join(dir, 'oversized-worker-error-runtime');
    await serve(join(runtime, 'supervisor.sock'), {
      ok: true,
      outcome: 'terminal',
      state: { ...state('settled'), workerExitCode: 1, workerError: 'x'.repeat(16 * 1024 + 1) },
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
    });
    const turn = client.startTurn(
      {
        store: {} as never,
        worktree: '/work/project',
        cwd: '/work/project',
        storeSessionId: 'session-1',
        turnId: 'turn-1',
        startCommandId: 'start-1',
      },
      {},
    );
    await expect(turn.result).rejects.toThrow('invalid runner supervisor turn state');
  });

  it('rejects a settled non-terminal stream instead of tailing forever', async () => {
    const runtime = join(dir, 'partial-runtime');
    const turnDir = join(runtime, 'turns', 'turn-1');
    await mkdir(turnDir, { recursive: true });
    const session = stampFrame(
      { kind: 'session', id: 'session-1' },
      { turnId: 'turn-1', runnerInstanceId: 'runner-1', frameSeq: 1 },
    );
    await writeFile(join(turnDir, 'events.jsonl'), `${JSON.stringify(session)}\n`);
    await serve(join(runtime, 'supervisor.sock'), {
      ok: true,
      outcome: 'terminal',
      state: state('settled'),
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
    });
    const turn = client.startTurn(
      {
        store: {} as never,
        worktree: '/work/project',
        cwd: '/work/project',
        storeSessionId: 'session-1',
        turnId: 'turn-1',
        startCommandId: 'start-1',
      },
      {},
    );
    await expect(turn.result).rejects.toThrow('no terminal result');
  });

  it('reports worker diagnostics for a settled partial event stream', async () => {
    const runtime = join(dir, 'failed-partial-runtime');
    const turnDir = join(runtime, 'turns', 'turn-1');
    await mkdir(turnDir, { recursive: true });
    await writeFile(
      join(turnDir, 'events.jsonl'),
      `${JSON.stringify(
        stampFrame(
          { kind: 'session', id: 'session-1' },
          { turnId: 'turn-1', runnerInstanceId: 'runner-1', frameSeq: 1 },
        ),
      )}\n`,
    );
    await serve(join(runtime, 'supervisor.sock'), {
      ok: true,
      outcome: 'terminal',
      state: {
        ...state('settled'),
        workerExitCode: 1,
        workerError: 'connector failed after worker startup',
      },
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
    });
    const turn = client.startTurn(
      {
        store: {} as never,
        worktree: '/work/project',
        cwd: '/work/project',
        storeSessionId: 'session-1',
        turnId: 'turn-1',
        startCommandId: 'start-1',
      },
      {},
    );
    await expect(turn.result).rejects.toThrow(
      'runner worker failed before producing a terminal event: connector failed after worker startup',
    );
  });

  it('keeps the stream-specific error for a successful worker with a partial stream', async () => {
    const runtime = join(dir, 'successful-partial-runtime');
    const turnDir = join(runtime, 'turns', 'turn-1');
    await mkdir(turnDir, { recursive: true });
    await writeFile(
      join(turnDir, 'events.jsonl'),
      `${JSON.stringify(
        stampFrame(
          { kind: 'session', id: 'session-1' },
          { turnId: 'turn-1', runnerInstanceId: 'runner-1', frameSeq: 1 },
        ),
      )}\n`,
    );
    await serve(join(runtime, 'supervisor.sock'), {
      ok: true,
      outcome: 'terminal',
      state: { ...state('settled'), workerExitCode: 0, workerSignal: null },
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
    });
    const turn = client.startTurn(
      {
        store: {} as never,
        worktree: '/work/project',
        cwd: '/work/project',
        storeSessionId: 'session-1',
        turnId: 'turn-1',
        startCommandId: 'start-1',
      },
      {},
    );
    await expect(turn.result).rejects.toThrow('settled runner event stream has no terminal result');
  });

  it('reports the worker signal when no stderr or exit code is available', async () => {
    const runtime = join(dir, 'signal-failure-runtime');
    await serve(join(runtime, 'supervisor.sock'), {
      ok: true,
      outcome: 'terminal',
      state: { ...state('settled'), workerExitCode: null, workerSignal: 'SIGKILL' },
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
    });
    const turn = client.startTurn(
      {
        store: {} as never,
        worktree: '/work/project',
        cwd: '/work/project',
        storeSessionId: 'session-1',
        turnId: 'turn-1',
        startCommandId: 'start-1',
      },
      {},
    );
    await expect(turn.result).rejects.toThrow(
      'runner worker failed before creating its event stream: worker terminated by signal SIGKILL',
    );
  });

  it('does not contact the supervisor for a pre-launch abort', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: join(dir, 'absent-runtime'),
      store,
      bus: new InMemoryEventBus(),
    });
    const turn = client.startTurn(
      {
        store: {} as never,
        worktree: '/work/project',
        cwd: '/work/project',
        storeSessionId: 'session-1',
        turnId: 'turn-1',
        startCommandId: 'start-1',
        signal: controller.signal,
      },
      {},
    );
    await expect(turn.result).rejects.toThrow('cancelled before launch');
  });
});

describe('SupervisorRunnerClient transcript sink (Stage 5b Slice 2)', () => {
  // Verbatim `.jsonl` transcripts are a Claude concept, and the fail-closed guard
  // below is scoped to that backend — so this describe stays on Claude, over ACP.
  const backend = { runnerSupervisorBackend: 'claude-acp' } as Backend;
  const store = {
    ingestRunnerFrame: async () => ({ outcome: 'accepted' as const }),
  } as RunnerFrameStore;

  /** A runtime whose supervisor settles the turn immediately, with a two-frame event
   * stream (session id `claudeSessionId`, then a terminal result). Records the order
   * of protocol requests so restore-before-launch ordering is observable. */
  async function settlingRuntime(name: string, claudeSessionId: string, order: string[]) {
    const runtime = join(dir, name);
    const turnDir = join(runtime, 'turns', 'turn-1');
    await mkdir(turnDir, { recursive: true });
    const frames = [
      stampFrame(
        { kind: 'session', id: claudeSessionId },
        { turnId: 'turn-1', runnerInstanceId: 'runner-1', frameSeq: 1 },
      ),
      stampFrame(
        {
          kind: 'result',
          result: { sessionId: claudeSessionId, exitCode: 0, stderr: '', aborted: false },
        },
        { turnId: 'turn-1', runnerInstanceId: 'runner-1', frameSeq: 2 },
      ),
    ];
    await writeFile(
      join(turnDir, 'events.jsonl'),
      `${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`,
    );
    const server = createServer((peer) => {
      sockets.add(peer);
      peer.once('close', () => sockets.delete(peer));
      peer.once('data', (data) => {
        const request = JSON.parse(data.toString('utf8')) as { kind: string };
        order.push(request.kind);
        peer.end(
          `${JSON.stringify({
            ok: true,
            ...(request.kind === 'start-turn' ? { outcome: 'created' } : {}),
            state: state(request.kind === 'start-turn' ? 'running' : 'settled'),
          })}\n`,
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(join(runtime, 'supervisor.sock'), resolve));
    return runtime;
  }

  it('restores before launch, tails on the session frame, and flushes on settle', async () => {
    const order: string[] = [];
    const runtime = await settlingRuntime('sink-resume', 'claude-session-1', order);
    let restoreArgs: [string, string] | undefined;
    let tailArgs: { sessionId: string; cwd: string; startOffset: number } | undefined;
    let tailAborted = false;
    const transcript = {
      restoreForResume: async (sessionId: string, cwd: string, storeSessionId: string) => {
        restoreArgs = [sessionId, cwd];
        expect(storeSessionId).toBe('session-1');
        order.push('restore');
        return 42;
      },
      tail: (
        sessionId: string,
        cwd: string,
        storeSessionId: string,
        startOffset: number,
        signal: AbortSignal,
      ) =>
        new Promise<void>((resolve) => {
          expect(storeSessionId).toBe('session-1');
          tailArgs = { sessionId, cwd, startOffset };
          const finish = (): void => {
            tailAborted = true;
            resolve();
          };
          if (signal.aborted) finish();
          else signal.addEventListener('abort', finish, { once: true });
        }),
    };
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      transcript,
    });
    const turn = client.startTurn(
      {
        store: {} as never,
        worktree: '/work',
        cwd: '/work',
        storeSessionId: 'session-1',
        turnId: 'turn-1',
        startCommandId: 'start-1',
        resumeSessionId: 'claude-session-1',
      },
      {},
    );
    await expect(turn.result).resolves.toMatchObject({ exitCode: 0 });
    // Restore ran BEFORE the worker was asked to start.
    expect(order.indexOf('restore')).toBeLessThan(order.indexOf('start-turn'));
    expect(restoreArgs).toEqual(['claude-session-1', '/work']);
    // Tail keyed by the CLAUDE session id from the session frame, seeded past the
    // restored bytes, and torn down (final flush) once the turn settled.
    expect(tailArgs).toEqual({ sessionId: 'claude-session-1', cwd: '/work', startOffset: 42 });
    expect(tailAborted).toBe(true);
  });

  it('starts a fresh-session tail at offset 0 and never restores', async () => {
    const order: string[] = [];
    const runtime = await settlingRuntime('sink-fresh', 'session-fresh', order);
    let restored = false;
    let tailArgs: { sessionId: string; startOffset: number } | undefined;
    const transcript = {
      restoreForResume: async () => {
        restored = true;
        return 99;
      },
      tail: (
        sessionId: string,
        _cwd: string,
        storeSessionId: string,
        startOffset: number,
        signal: AbortSignal,
      ) =>
        new Promise<void>((resolve) => {
          expect(storeSessionId).toBe('session-1');
          tailArgs = { sessionId, startOffset };
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    };
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      transcript,
    });
    const turn = client.startTurn(
      {
        store: {} as never,
        worktree: '/work',
        cwd: '/work',
        storeSessionId: 'session-1',
        turnId: 'turn-1',
        startCommandId: 'start-1',
      },
      {},
    );
    await expect(turn.result).resolves.toMatchObject({ exitCode: 0 });
    expect(restored).toBe(false);
    expect(tailArgs).toEqual({ sessionId: 'session-fresh', startOffset: 0 });
  });

  it('does not trip the guard on opts.transcript when a server sink owns persistence', async () => {
    const order: string[] = [];
    const runtime = await settlingRuntime('sink-guard', 'session-guard', order);
    const transcript = {
      restoreForResume: async () => 0,
      tail: (_s: string, _c: string, _store: string, _o: number, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    };
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      transcript,
    });
    const turn = client.startTurn(
      {
        store: {} as never,
        worktree: '/work',
        cwd: '/work',
        storeSessionId: 'session-1',
        turnId: 'turn-1',
        startCommandId: 'start-1',
        // A DB transcript store leaking through does NOT trip the guard when the
        // server sink owns persistence.
        transcript: {} as never,
      },
      {},
    );
    await expect(turn.result).resolves.toMatchObject({ exitCode: 0 });
  });

  it('still fails closed on opts.transcript when NO server sink is configured', async () => {
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: join(dir, 'sink-missing'),
      store,
      bus: new InMemoryEventBus(),
    });
    const turn = client.startTurn(
      {
        store: {} as never,
        worktree: '/work',
        cwd: '/work',
        storeSessionId: 'session-1',
        turnId: 'turn-1',
        startCommandId: 'start-1',
        transcript: {} as never,
      },
      {},
    );
    await expect(turn.result).rejects.toThrow('without a server sink');
  });
});

describe('SupervisorRunnerRecovery', () => {
  async function fixture(
    status: 'claimed' | 'running' | 'settled' = 'running',
    eventContents: string | null = '{}\n',
    projectId = 'project-1',
    sessionProjectId: string | null = projectId,
  ) {
    const runtime = join(dir, 'runners', projectId);
    const turn = join(runtime, 'turns', 'turn-1');
    await mkdir(turn, { recursive: true });
    if (eventContents !== null) await writeFile(join(turn, 'events.jsonl'), eventContents);
    const supervisor = join(runtime, 'supervisor.sock');
    await serve(supervisor, { ok: true, state: state(status) });
    if (status === 'running') {
      const control = createServer();
      servers.push(control);
      await new Promise<void>((resolve, reject) => {
        control.once('error', reject);
        control.listen(join(turn, 'control.sock'), resolve);
      });
    }
    return new SupervisorRunnerRecovery({
      dataVolumeRoot: dir,
      getSession: async () => ({ projectId: sessionProjectId }),
      ...(sessionProjectId === null ? { controlPlaneProjectId: projectId } : {}),
    });
  }

  it('returns the Server-visible durable artifacts for a running turn', async () => {
    const recovery = await fixture();
    await expect(
      recovery.discover({ sessionId: 'session-1', turnId: 'turn-1', startCommandId: 'start-1' }),
    ).resolves.toEqual({
      status: 'live',
      target: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        protocolVersion: 1,
        controlCapability: 'start-1',
        eventFilePath: join(dir, 'runners/project-1/turns/turn-1/events.jsonl'),
        controlSocketPath: join(dir, 'runners/project-1/turns/turn-1/control.sock'),
      },
    });
  });

  it('recovers a project-less session from the dedicated control-plane runtime', async () => {
    const recovery = await fixture('running', '{}\n', 'verity-control', null);

    await expect(
      recovery.discover({ sessionId: 'control-1', turnId: 'turn-1', startCommandId: 'start-1' }),
    ).resolves.toMatchObject({
      status: 'live',
      target: {
        sessionId: 'control-1',
        eventFilePath: join(dir, 'runners/verity-control/turns/turn-1/events.jsonl'),
      },
    });
  });

  it('returns a settled turn for terminal-frame ingestion without requiring control', async () => {
    const result = stampFrame(
      {
        kind: 'result',
        result: { sessionId: 'session-1', exitCode: 0, stderr: '', aborted: false },
      },
      { turnId: 'turn-1', runnerInstanceId: 'runner-1', frameSeq: 1 },
    );
    const recovery = await fixture('settled', `${JSON.stringify(result)}\n`);
    await expect(
      recovery.discover({ sessionId: 's', turnId: 'turn-1', startCommandId: 'start-1' }),
    ).resolves.toMatchObject({ status: 'live', target: { turnId: 'turn-1' } });
  });

  it('confirms a settled worker without a terminal result as dead', async () => {
    const partialEvent = stampFrame(
      { kind: 'event', event: { t: 'text', delta: 'partial output' } },
      { turnId: 'turn-1', runnerInstanceId: 'runner-1', frameSeq: 1 },
    );
    const recovery = await fixture('settled', `${JSON.stringify(partialEvent)}\n`);
    await expect(
      recovery.discover({ sessionId: 's', turnId: 'turn-1', startCommandId: 'start-1' }),
    ).resolves.toEqual({ status: 'dead' });
  });

  it('confirms a settled worker that died before creating its event stream as dead', async () => {
    const recovery = await fixture('settled', null);
    await expect(
      recovery.discover({ sessionId: 's', turnId: 'turn-1', startCommandId: 'start-1' }),
    ).resolves.toEqual({ status: 'dead' });
  });

  it('does not follow a settled turn event-stream symlink', async () => {
    const recovery = await fixture('settled', null);
    const outside = join(dir, 'outside-events.jsonl');
    await writeFile(outside, '{}\n');
    await symlink(outside, join(dir, 'runners/project-1/turns/turn-1/events.jsonl'));
    await expect(
      recovery.discover({ sessionId: 's', turnId: 'turn-1', startCommandId: 'start-1' }),
    ).resolves.toEqual({ status: 'uncertain' });
  });

  it('bounds the terminal-frame tail read for a settled turn', async () => {
    const oversized = {
      ...stampFrame(
        {
          kind: 'result',
          result: { sessionId: 'session-1', exitCode: 0, stderr: '', aborted: false },
        },
        { turnId: 'turn-1', runnerInstanceId: 'runner-1', frameSeq: 1 },
      ),
      padding: 'x'.repeat(1024 * 1024),
    };
    const recovery = await fixture('settled', `${JSON.stringify(oversized)}\n`);
    await expect(
      recovery.discover({ sessionId: 's', turnId: 'turn-1', startCommandId: 'start-1' }),
    ).resolves.toEqual({ status: 'uncertain' });
  });

  it('keeps claimed, conflicting, unavailable, and malformed turns uncertain', async () => {
    const claimed = await fixture('claimed');
    await expect(
      claimed.discover({ sessionId: 's', turnId: 'turn-1', startCommandId: 'start-1' }),
    ).resolves.toEqual({ status: 'uncertain' });
    await expect(
      claimed.discover({ sessionId: 's', turnId: 'turn-1', startCommandId: 'different' }),
    ).resolves.toEqual({ status: 'uncertain' });
    const unavailable = new SupervisorRunnerRecovery({
      dataVolumeRoot: dir,
      getSession: async () => ({ projectId: 'missing-project' }),
    });
    await expect(
      unavailable.discover({ sessionId: 's', turnId: 'turn-1', startCommandId: 'start-1' }),
    ).resolves.toEqual({ status: 'uncertain' });
  });

  it('keeps a missing state uncertain because claim may be between mkdir and state write', async () => {
    const runtime = join(dir, 'runners', 'project-1');
    await serve(join(runtime, 'supervisor.sock'), { ok: true, state: undefined });
    const recovery = new SupervisorRunnerRecovery({
      dataVolumeRoot: dir,
      getSession: async () => ({ projectId: 'project-1' }),
    });
    await expect(
      recovery.discover({ sessionId: 's', turnId: 'turn-1', startCommandId: 'start-1' }),
    ).resolves.toEqual({ status: 'uncertain' });
  });
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

describe('runSupervisorTrustedCli result validation', () => {
  // The supervisor runs the command under a real identity and reports what it
  // observed. A result this Server cannot validate is a result it must not hand
  // back as an execution outcome: an out-of-range or mistyped exit code read as
  // success is a failed deploy reported as a green one.
  it.each([
    ['a non-integer exit code', 'code-type', { exitCode: '0', stdout: '', stderr: '' }],
    ['an exit code above the POSIX range', 'code-high', { exitCode: 256, stdout: '', stderr: '' }],
    ['a negative exit code', 'code-neg', { exitCode: -1, stdout: '', stderr: '' }],
    ['a missing stdout', 'no-stdout', { exitCode: 0, stderr: '' }],
    ['a non-string stderr', 'stderr-type', { exitCode: 0, stdout: '', stderr: 12 }],
    [
      'a falsified timedOut flag',
      'timed-out',
      { exitCode: 0, stdout: '', stderr: '', timedOut: false },
    ],
    [
      'a falsified truncated flag',
      'truncated',
      { exitCode: 0, stdout: '', stderr: '', truncated: 'yes' },
    ],
  ])('rejects %s', async (_label, slug, result) => {
    const runtime = join(dir, `cli-${slug}`);
    await serveByKind(join(runtime, 'supervisor.sock'), {
      'run-trusted-cli': { ok: true, ...result },
    });

    await expect(
      runSupervisorTrustedCli(runtime, { turnId: 'turn-1', secrets: [], command: ['/usr/bin/id'] }),
    ).rejects.toThrow('runner supervisor returned an invalid trusted CLI result');
  });

  it('accepts the edges of the valid envelope', async () => {
    const runtime = join(dir, 'trusted-cli-edges');
    await serveByKind(join(runtime, 'supervisor.sock'), {
      'run-trusted-cli': { ok: true, exitCode: 255, stdout: '', stderr: 'died', timedOut: true },
    });

    await expect(
      runSupervisorTrustedCli(runtime, { turnId: 'turn-1', secrets: [], command: ['/usr/bin/id'] }),
    ).resolves.toEqual({ exitCode: 255, stdout: '', stderr: 'died', timedOut: true });
  });

  // The client method is the only entry point a turn has, and it must reach the
  // SAME supervisor socket the client was built for. A secret with no explicit
  // injection mode must not gain one on the wire either — the supervisor picks the
  // default, and inventing `env` here would put a file-only secret in the argv
  // environment.
  it('routes the client method at the client’s own runtime and preserves the secret shape', async () => {
    const runtime = join(dir, 'trusted-cli-client-runtime');
    const requests = await serveByKind(join(runtime, 'supervisor.sock'), {
      'run-trusted-cli': { ok: true, exitCode: 0, stdout: 'ok', stderr: '' },
    });
    const client = new SupervisorRunnerClient({ runnerSupervisorBackend: 'codex-acp' } as Backend, {
      runtimeDir: runtime,
      store: { ingestRunnerFrame: async () => ({ outcome: 'accepted' as const }) },
      bus: new InMemoryEventBus(),
    });

    await expect(
      client.runTrustedCli({
        turnId: 'turn-1',
        secrets: [{ secretAlias: 'TOKEN', env: 'TOKEN', secret: 'value' }],
        command: ['/usr/bin/gh', 'pr', 'list'],
      }),
    ).resolves.toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });
    expect(requests).toEqual([
      {
        protocolVersion: 1,
        kind: 'run-trusted-cli',
        turnId: 'turn-1',
        secrets: [{ secretAlias: 'TOKEN', env: 'TOKEN', secret: 'value' }],
        command: ['/usr/bin/gh', 'pr', 'list'],
      },
    ]);
  });
  it('classifies a missing supervisor as a definitive pre-start failure', async () => {
    const runtime = join(dir, 'missing-trusted-cli-supervisor');
    await expect(
      runSupervisorTrustedCli(runtime, {
        turnId: 'turn-1',
        secrets: [{ secretAlias: 'TOKEN', env: 'TOKEN', secret: 'value' }],
        command: ['/usr/bin/true'],
      }),
    ).rejects.toMatchObject({
      name: 'TrustedCliDispatchError',
      stage: 'runner supervisor connection',
      executionStarted: false,
    });
  });

  it.each(['validation', 'materialization', 'launch-spec', 'spawn'] as const)(
    'preserves a sanitized broker %s failure without exposing free text',
    async (phase) => {
      const runtime = join(dir, `trusted-cli-${phase}-failure`);
      const socket = join(runtime, 'supervisor.sock');
      const secret = 'dp.st.must-not-escape';
      await mkdir(runtime, { recursive: true });
      const server = createServer((connection) => {
        connection.once('data', () =>
          connection.end(
            `${JSON.stringify({
              ok: false,
              error: `trusted CLI broker rejected execution: unsafe ${secret} /run/secrets/file`,
              trustedCliFailure: { phase, cause: `${phase} failed` },
            })}\n`,
          ),
        );
      });
      await new Promise<void>((resolveListen) => server.listen(socket, resolveListen));
      try {
        const failure = await runSupervisorTrustedCli(runtime, {
          turnId: 'turn-1',
          secrets: [{ secretAlias: 'TOKEN', env: 'TOKEN', secret }],
          command: ['/usr/bin/true'],
        }).catch((error: unknown) => error);
        expect(failure).toMatchObject({
          name: 'TrustedCliDispatchError',
          stage: 'spawn broker dispatch',
          executionStarted: false,
          brokerFailure: { phase, cause: `${phase} failed` },
        });
        expect(trustedCliDispatchMessage(failure as TrustedCliDispatchError)).toBe(
          `Trusted CLI dispatch failed during spawn broker dispatch. Broker phase: ${phase}; cause: ${phase} failed. The command was not started. No secret value was exposed.`,
        );
        expect(JSON.stringify(failure)).not.toContain(secret);
        expect(trustedCliDispatchMessage(failure as TrustedCliDispatchError)).not.toContain(
          '/run/secrets/file',
        );
      } finally {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      }
    },
  );

  it('does not claim pre-start when the supervisor response is lost', async () => {
    const runtime = join(dir, 'lost-trusted-cli-supervisor-response');
    const socket = join(runtime, 'supervisor.sock');
    await mkdir(runtime, { recursive: true });
    const server = createServer((connection) => {
      connection.once('data', () => connection.destroy());
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      await expect(
        runSupervisorTrustedCli(runtime, {
          turnId: 'turn-1',
          secrets: [{ secretAlias: 'TOKEN', env: 'TOKEN', secret: 'value' }],
          command: ['/usr/bin/true'],
        }),
      ).rejects.toMatchObject({
        name: 'TrustedCliDispatchError',
        stage: 'runner supervisor response',
        executionStarted: 'unknown',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('accepts a start acknowledgement before a delayed trusted CLI result', async () => {
    const runtime = join(dir, 'acknowledged-trusted-cli-supervisor');
    const socket = join(runtime, 'supervisor.sock');
    await mkdir(runtime, { recursive: true });
    const server = createServer((connection) => {
      connection.once('data', () => {
        connection.write(`${JSON.stringify({ ok: true, kind: 'trusted-cli-started' })}\n`);
        setTimeout(
          () =>
            connection.end(
              `${JSON.stringify({ ok: true, exitCode: 0, stdout: 'ok', stderr: '' })}\n`,
            ),
          40,
        );
      });
    });
    await new Promise<void>((resolveListen) => server.listen(socket, resolveListen));
    try {
      await expect(
        runSupervisorTrustedCli(
          runtime,
          {
            turnId: 'turn-1',
            secrets: [{ secretAlias: 'TOKEN', env: 'TOKEN', secret: 'value' }],
            command: ['/usr/bin/true'],
          },
          { startAckTimeoutMs: 20, resultTimeoutMs: 200 },
        ),
      ).resolves.toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('bounds a connected supervisor that never acknowledges trusted CLI start', async () => {
    const runtime = join(dir, 'unacknowledged-trusted-cli-supervisor');
    const socket = join(runtime, 'supervisor.sock');
    await mkdir(runtime, { recursive: true });
    const connections = new Set<import('node:net').Socket>();
    const server = createServer((connection) => {
      connections.add(connection);
      connection.once('close', () => connections.delete(connection));
      connection.resume();
    });
    await new Promise<void>((resolveListen) => server.listen(socket, resolveListen));
    try {
      await expect(
        runSupervisorTrustedCli(
          runtime,
          {
            turnId: 'turn-1',
            secrets: [{ secretAlias: 'TOKEN', env: 'TOKEN', secret: 'value' }],
            command: ['/usr/bin/true'],
          },
          { startAckTimeoutMs: 20, resultTimeoutMs: 200 },
        ),
      ).rejects.toMatchObject({
        name: 'TrustedCliDispatchError',
        stage: 'runner supervisor response',
        executionStarted: 'unknown',
      });
    } finally {
      for (const connection of connections) connection.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it.each([
    {
      name: 'broker refusal',
      afterStart: (connection: import('node:net').Socket) =>
        connection.end(
          `${JSON.stringify({ ok: false, error: 'trusted CLI broker rejected execution: cleanup failed' })}\n`,
        ),
    },
    {
      name: 'lost transport',
      afterStart: (connection: import('node:net').Socket) =>
        setTimeout(() => connection.destroy(), 10),
    },
  ])('never claims pre-start for a $name after start acknowledgement', async ({ afterStart }) => {
    const runtime = join(dir, 'post-start-trusted-cli-supervisor');
    const socket = join(runtime, 'supervisor.sock');
    await mkdir(runtime, { recursive: true });
    const server = createServer((connection) => {
      connection.once('data', () => {
        connection.write(`${JSON.stringify({ ok: true, kind: 'trusted-cli-started' })}\n`);
        afterStart(connection);
      });
    });
    await new Promise<void>((resolveListen) => server.listen(socket, resolveListen));
    try {
      await expect(
        runSupervisorTrustedCli(
          runtime,
          {
            turnId: 'turn-1',
            secrets: [{ secretAlias: 'TOKEN', env: 'TOKEN', secret: 'value' }],
            command: ['/usr/bin/true'],
          },
          { startAckTimeoutMs: 100, resultTimeoutMs: 200 },
        ),
      ).rejects.toMatchObject({
        name: 'TrustedCliDispatchError',
        stage: 'runner supervisor response',
        executionStarted: 'unknown',
      });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});

describe('SupervisorRunnerClient.forceCancel', () => {
  const backend = { runnerSupervisorBackend: 'codex-acp' } as Backend;
  const store = {
    ingestRunnerFrame: async () => ({ outcome: 'accepted' as const }),
  } as RunnerFrameStore;

  /** Reattach to a turn whose artifacts never appear, so the handle stays live and
   * the only thing under test is how `forceCancel` talks to the supervisor. */
  function reattach(runtime: string, turnId = 'turn-1') {
    const client = new SupervisorRunnerClient(backend, {
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

describe('SupervisorRunnerClient launch preconditions', () => {
  const backend = { runnerSupervisorBackend: 'codex-acp' } as Backend;
  const store = {
    ingestRunnerFrame: async () => ({ outcome: 'accepted' as const }),
  } as RunnerFrameStore;

  // Both ids are the turn's durable identity: `startCommandId` is what the
  // supervisor echoes back to prove it started THIS attempt rather than an earlier
  // one, and `storeSessionId` is the row every ingested frame is claimed against.
  it.each([
    ['a missing startCommandId', {}, 'supervisor runner requires startCommandId'],
    [
      'an unsafe startCommandId',
      { startCommandId: '../escape' },
      'supervisor runner requires startCommandId',
    ],
    [
      'a missing storeSessionId',
      { startCommandId: 'start-1' },
      'supervisor runner requires storeSessionId',
    ],
    [
      'an unsafe storeSessionId',
      { startCommandId: 'start-1', storeSessionId: 'session/1' },
      'supervisor runner requires storeSessionId',
    ],
  ])('refuses a launch with %s', async (_label, opts, message) => {
    const runtime = join(dir, 'launch-precondition');
    const requests = await serveByKind(join(runtime, 'supervisor.sock'), {
      'start-turn': { ok: true, outcome: 'created', state: state('running') },
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
    });
    const turn = client.startTurn(
      {
        store: {} as never,
        worktree: '/work/project',
        cwd: '/work/project',
        turnId: 'turn-1',
        ...opts,
      },
      {},
    );

    await expect(turn.result).rejects.toThrow(message);
    // Refused before anything reached the Sandbox.
    expect(requests).toEqual([]);
  });
});

describe('SupervisorRunnerClient artifact readiness', () => {
  const backend = { runnerSupervisorBackend: 'codex-acp' } as Backend;
  const store = {
    ingestRunnerFrame: async () => ({ outcome: 'accepted' as const }),
  } as RunnerFrameStore;

  function start(runtime: string) {
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      // Deliberately longer than artifactTimeoutMs: a control-request override
      // must not let one readiness poll escape the artifact deadline.
      timeoutMs: 5_000,
      artifactTimeoutMs: 150,
    });
    return client.startTurn(
      {
        store: {} as never,
        worktree: '/work/project',
        cwd: '/work/project',
        storeSessionId: 'session-1',
        turnId: 'turn-1',
        startCommandId: 'start-1',
      },
      {},
    );
  }

  it('waits through a slow artifact-state poll within the readiness budget', async () => {
    const runtime = join(dir, 'artifacts-slow-state');
    const turnDir = join(runtime, 'turns', 'turn-1');
    await mkdir(turnDir, { recursive: true });
    const frames = [
      stampFrame(
        { kind: 'session', id: 'session-1' },
        { turnId: 'turn-1', runnerInstanceId: 'runner-1', frameSeq: 1 },
      ),
      stampFrame(
        {
          kind: 'result',
          result: { sessionId: 'session-1', exitCode: 0, stderr: '', aborted: false },
        },
        { turnId: 'turn-1', runnerInstanceId: 'runner-1', frameSeq: 2 },
      ),
    ];
    await writeFile(
      join(turnDir, 'events.jsonl'),
      `${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`,
    );
    const supervisor = createServer((peer) => {
      sockets.add(peer);
      peer.once('close', () => sockets.delete(peer));
      peer.once('data', (data) => {
        const request = JSON.parse(data.toString()) as { kind: string };
        if (request.kind === 'start-turn') {
          peer.end(
            `${JSON.stringify({ ok: true, outcome: 'created', state: state('running') })}\n`,
          );
          return;
        }
        setTimeout(
          () => peer.end(`${JSON.stringify({ ok: true, state: state('settled') })}\n`),
          1_200,
        );
      });
    });
    servers.push(supervisor);
    await new Promise<void>((resolve) =>
      supervisor.listen(join(runtime, 'supervisor.sock'), resolve),
    );
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      artifactTimeoutMs: 2_000,
    });

    await expect(
      client.startTurn(
        {
          store: {} as never,
          worktree: '/work/project',
          cwd: '/work/project',
          storeSessionId: 'session-1',
          turnId: 'turn-1',
          startCommandId: 'start-1',
        },
        {},
      ).result,
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it('fences a running turn when its artifact-state poll exhausts the deadline', async () => {
    const runtime = join(dir, 'artifacts-state-timeout');
    await mkdir(runtime, { recursive: true });
    const requests: string[] = [];
    const supervisor = createServer((peer) => {
      sockets.add(peer);
      peer.once('close', () => sockets.delete(peer));
      peer.once('data', (data) => {
        const request = JSON.parse(data.toString()) as { kind: string };
        requests.push(request.kind);
        if (request.kind === 'start-turn') {
          peer.end(
            `${JSON.stringify({ ok: true, outcome: 'created', state: state('running') })}\n`,
          );
        } else if (request.kind === 'cancel-turn') {
          peer.end(`${JSON.stringify({ ok: true, outcome: 'cancelled' })}\n`);
        }
        // Leave get-turn unanswered so its request consumes the artifact budget.
      });
    });
    servers.push(supervisor);
    await new Promise<void>((resolve) =>
      supervisor.listen(join(runtime, 'supervisor.sock'), resolve),
    );
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      timeoutMs: 5_000,
      artifactTimeoutMs: 100,
    });

    await expect(
      client.startTurn(
        {
          store: {} as never,
          worktree: '/work/project',
          cwd: '/work/project',
          storeSessionId: 'session-1',
          turnId: 'turn-1',
          startCommandId: 'start-1',
        },
        {},
      ).result,
    ).rejects.toThrow('runner control socket did not become ready');
    expect(requests).toContain('cancel-turn');
  });

  // The supervisor reports a DIFFERENT start command for this turn id: the turn
  // the Server started is gone and something else holds the id. Waiting for its
  // artifacts would attach this Server's tail to another attempt's stream.
  it('fails when the supervisor reports a different start command for the turn', async () => {
    const runtime = join(dir, 'artifacts-lost-turn');
    await serveByKind(join(runtime, 'supervisor.sock'), {
      'start-turn': { ok: true, outcome: 'created', state: state('running') },
      'get-turn': { ok: true, state: { ...state('running'), startCommandId: 'start-2' } },
    });

    await expect(start(runtime).result).rejects.toThrow('runner supervisor lost the started turn');
  });

  it('fails when the supervisor forgets the turn entirely', async () => {
    const runtime = join(dir, 'artifacts-forgotten-turn');
    await serveByKind(join(runtime, 'supervisor.sock'), {
      'start-turn': { ok: true, outcome: 'created', state: state('running') },
      'get-turn': { ok: true },
    });

    await expect(start(runtime).result).rejects.toThrow('runner supervisor lost the started turn');
  });

  // A worker that stays 'running' without ever binding its control socket leaves a
  // turn with no way to steer or cancel it; the wait is bounded so that surfaces
  // as a failed start rather than a turn that hangs.
  it('gives up on a control socket that never appears, and fences the worker', async () => {
    const runtime = join(dir, 'artifacts-no-socket');
    const requests = await serveByKind(join(runtime, 'supervisor.sock'), {
      'start-turn': { ok: true, outcome: 'created', state: state('running') },
      'get-turn': { ok: true, state: state('running') },
      'cancel-turn': { ok: true, outcome: 'cancelled' },
    });

    await expect(start(runtime).result).rejects.toThrow(
      'runner control socket did not become ready',
    );
    // Bounding the wait is only half the answer. The supervisor has said `running`
    // throughout, so walking away without this cancel leaves a live worker on the
    // worktree with nothing tailing it — the orphan the uncertain-start fence exists
    // to prevent, reached by the one path that used to skip it.
    expect(requests.filter((request) => request.kind === 'cancel-turn')).toEqual([
      expect.objectContaining({ turnId: 'turn-1' }),
    ]);
  });

  // And the limit of that rule. A state carrying somebody ELSE's start command is
  // not this Server's worker to cancel: the turn id would be the only thing the
  // fence matched on, and it would kill a turn that is running correctly for
  // whoever started it. Failing bare is the conservative answer, and recovery is
  // what settles anything genuinely stranded.
  it('does not fence a turn another start command owns', async () => {
    const runtime = join(dir, 'artifacts-foreign-owner');
    const requests = await serveByKind(join(runtime, 'supervisor.sock'), {
      'start-turn': { ok: true, outcome: 'created', state: state('running') },
      'get-turn': { ok: true, state: { ...state('running'), startCommandId: 'start-2' } },
      'cancel-turn': { ok: true, outcome: 'cancelled' },
    });

    await expect(start(runtime).result).rejects.toThrow('runner supervisor lost the started turn');
    expect(requests.filter((request) => request.kind === 'cancel-turn')).toHaveLength(0);
  });

  // Rejecting the ANSWER is not the same as nothing having happened. `created` says
  // this frame made the turn, so a state that contradicts it still describes a
  // worker this Server started and is about to stop tailing.
  it('fences a start it created but cannot reconcile with the reported state', async () => {
    const runtime = join(dir, 'artifacts-conflicting-state');
    const requests = await serveByKind(join(runtime, 'supervisor.sock'), {
      'start-turn': { ok: true, outcome: 'created', state: state('settled') },
      'cancel-turn': { ok: true, outcome: 'cancelled' },
    });

    await expect(start(runtime).result).rejects.toThrow(
      'runner supervisor returned conflicting turn state',
    );
    expect(requests.filter((request) => request.kind === 'cancel-turn')).toEqual([
      expect.objectContaining({ turnId: 'turn-1' }),
    ]);
  });

  // And the case that must not be fenced. `already-running` under another start
  // command means the turn belongs to somebody else's attempt; a cancel matches on
  // turn id alone, so firing here would end a turn that is running correctly.
  it('does not fence a start already running under another command', async () => {
    const runtime = join(dir, 'artifacts-foreign-running');
    const requests = await serveByKind(join(runtime, 'supervisor.sock'), {
      'start-turn': {
        ok: true,
        outcome: 'already-running',
        state: { ...state('running'), startCommandId: 'start-2' },
      },
      'cancel-turn': { ok: true, outcome: 'cancelled' },
    });

    await expect(start(runtime).result).rejects.toThrow(
      'runner supervisor returned conflicting turn state',
    );
    expect(requests.filter((request) => request.kind === 'cancel-turn')).toHaveLength(0);
  });

  // The state is read out of the shared runtime, so every field is validated. A
  // signal name or exit code this Server cannot interpret must fail the turn
  // rather than be reported as some default disposition.
  it.each([
    ['a signal that is not a signal name', 'signal', { workerSignal: 'KILL' }],
    ['a non-integer exit code', 'code', { workerExitCode: 1.5 }],
    ['an unsafe runner instance id', 'instance', { runnerInstanceId: '../escape' }],
    ['a status outside the state machine', 'status', { status: 'wedged' }],
    ['an unsafe start command id', 'startcmd', { startCommandId: 'start/1' }],
  ])('refuses supervisor state carrying %s', async (_label, slug, overrides) => {
    const runtime = join(dir, `state-${slug}`);
    await serveByKind(join(runtime, 'supervisor.sock'), {
      'start-turn': { ok: true, outcome: 'created', state: { ...state('running'), ...overrides } },
    });

    await expect(start(runtime).result).rejects.toThrow('invalid runner supervisor turn state');
  });
});

describe('requestRunnerSupervisor framing', () => {
  it('refuses a response that is not exactly one frame', async () => {
    const twoFrames = join(dir, 'two-frames.sock');
    await mkdir(join(twoFrames, '..'), { recursive: true });
    const pipelined = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.once('data', () =>
        socket.end(`${JSON.stringify({ ok: true })}\n${JSON.stringify({ ok: true })}\n`),
      );
    });
    servers.push(pipelined);
    await new Promise<void>((resolve) => pipelined.listen(twoFrames, resolve));
    await expect(requestRunnerSupervisor(twoFrames, { kind: 'status' })).rejects.toThrow(
      'runner supervisor returned an invalid frame count',
    );

    const empty = join(dir, 'empty-frame.sock');
    const blank = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.once('data', () => socket.end('\n'));
    });
    servers.push(blank);
    await new Promise<void>((resolve) => blank.listen(empty, resolve));
    await expect(requestRunnerSupervisor(empty, { kind: 'status' })).rejects.toThrow(
      'runner supervisor returned an invalid frame count',
    );
  });
});

/**
 * The incident this suite exists for: `runner supervisor request timed out:
 * start-turn`, followed by `agent exited with code 1 without a terminal event`.
 *
 * The Server had given `start-turn` the same one-second budget as a state read,
 * abandoned a turn the Sandbox had in fact started, and — because the Conductor
 * mints a fresh turn id per attempt — let the operator's retry spawn a SECOND
 * worker against the same worktree. Every test here pins one link of that chain.
 */
describe('SupervisorRunnerClient start-turn resilience', () => {
  const backend = { runnerSupervisorBackend: 'codex-acp' } as Backend;
  const store = {
    ingestRunnerFrame: async () => ({ outcome: 'accepted' as const }),
  } as RunnerFrameStore;

  /** A turn stream that already carries a session frame and a clean terminal result,
   *  so a start that survives long enough to reach the tail resolves. */
  async function writeCompletedStream(turnDir: string): Promise<void> {
    await mkdir(turnDir, { recursive: true });
    const frames = [
      stampFrame(
        { kind: 'session', id: 'session-1' },
        { turnId: 'turn-1', runnerInstanceId: 'runner-1', frameSeq: 1 },
      ),
      stampFrame(
        {
          kind: 'result',
          result: { sessionId: 'session-1', exitCode: 0, stderr: '', aborted: false },
        },
        { turnId: 'turn-1', runnerInstanceId: 'runner-1', frameSeq: 2 },
      ),
    ];
    await writeFile(
      join(turnDir, 'events.jsonl'),
      `${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`,
    );
  }

  /**
   * A supervisor stand-in that records every frame it is sent and answers each
   * request kind through `reply`, which writes on the socket itself so a test can
   * acknowledge now and answer later.
   */
  async function serveSupervisor(
    runtime: string,
    reply: (request: Record<string, unknown>, socket: Socket) => void,
  ): Promise<Record<string, unknown>[]> {
    const received: Record<string, unknown>[] = [];
    await mkdir(runtime, { recursive: true });
    const server = createServer((peer) => {
      sockets.add(peer);
      peer.once('close', () => sockets.delete(peer));
      peer.once('data', (data: Buffer) => {
        const request = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        received.push(request);
        reply(request, peer);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(join(runtime, 'supervisor.sock'), resolve));
    return received;
  }

  function startTurn(
    client: SupervisorRunnerClient,
  ): ReturnType<SupervisorRunnerClient['startTurn']> {
    return client.startTurn(
      {
        store: {} as never,
        worktree: '/work/project',
        cwd: '/work/project',
        storeSessionId: 'session-1',
        turnId: 'turn-1',
        startCommandId: 'start-1',
      },
      {},
    );
  }

  const acceptFrame = (request: Record<string, unknown>): string =>
    `${JSON.stringify({ ok: true, kind: 'start-accepted', turnId: request.turnId })}\n`;

  // The bug itself. A supervisor that claims the turn, forks `flock`, forks the
  // worker and fsyncs its way through four state writes is slow, not broken — and
  // the Server used to give that the budget of a state read.
  it('survives a start that takes far longer than the control-request budget', async () => {
    const runtime = join(dir, 'slow-start-runtime');
    await writeCompletedStream(join(runtime, 'turns', 'turn-1'));
    const telemetry: SupervisorStartTelemetry[] = [];
    const received = await serveSupervisor(runtime, (request, peer) => {
      if (request.kind !== 'start-turn') {
        peer.end(`${JSON.stringify({ ok: true, state: state('settled') })}\n`);
        return;
      }
      peer.write(acceptFrame(request));
      // Longer than `timeoutMs` below by a wide margin: under the old single-budget
      // transport this is the exact shape that produced the operator's timeout.
      setTimeout(
        () =>
          peer.end(
            `${JSON.stringify({ ok: true, outcome: 'created', state: state('running') })}\n`,
          ),
        700,
      );
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      timeoutMs: 200,
      onTelemetry: (record) => telemetry.push(record),
    });
    await expect(startTurn(client).result).resolves.toMatchObject({
      exitCode: 0,
      sessionId: 'session-1',
    });
    expect(received.filter((request) => request.kind === 'start-turn')).toHaveLength(1);
    expect(telemetry.at(-1)).toMatchObject({ outcome: 'created', activeStarts: 0 });
    expect(telemetry.at(-1)?.acceptMs).toBeTypeOf('number');
    expect(telemetry.at(-1)?.startMs).toBeGreaterThanOrEqual(700);
  });

  // The opposite end of the same judgement. Nothing was written, so nothing was
  // started, so there is nothing to reconcile with and no worker to fence: an absent
  // socket is a DECIDED failure. Classified as a lost answer instead, this start
  // would spend the whole ladder — accept, reconcile, re-send, reconcile — asking an
  // absent peer about a turn that does not exist, and then brand it `start-uncertain`,
  // the one reason the Conductor must never retry, for a sandbox that was merely
  // restarting.
  it('fails a missing supervisor socket at once instead of reconciling with nobody', async () => {
    const runtime = join(dir, 'absent-supervisor-runtime');
    await mkdir(runtime, { recursive: true });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      // The PRODUCTION budgets, deliberately: a regression does not make this test
      // fail an assertion, it makes it exhaust the runner's own timeout — which is
      // exactly the complaint an operator would file about the same regression.
    });
    const failure: unknown = await startTurn(client).result.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('ENOENT');
    // Not the fenced kind: `launch` fences on this reason alone, and a cancel sent to
    // a socket that does not exist can only fail in its own right.
    expect(failure).not.toBeInstanceOf(RunnerWorkerStartFailure);
  });

  // The Server's answer is not the turn; the durable state the supervisor wrote
  // before answering is. A lost response is therefore a question to ask, not a
  // session to kill — and asking it is only possible because the Server minted the
  // turn id before the launch (ADR 0006 D2).
  it('adopts a live turn when the start response never arrives, without re-sending', async () => {
    const runtime = join(dir, 'lost-response-runtime');
    await writeCompletedStream(join(runtime, 'turns', 'turn-1'));
    const telemetry: SupervisorStartTelemetry[] = [];
    const received = await serveSupervisor(runtime, (request, peer) => {
      if (request.kind === 'start-turn') {
        // Accepted, then silence: the supervisor is working and the answer is lost.
        peer.write(acceptFrame(request));
        return;
      }
      peer.end(`${JSON.stringify({ ok: true, state: state('settled') })}\n`);
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      startTimeoutMs: 150,
      onTelemetry: (record) => telemetry.push(record),
    });
    await expect(startTurn(client).result).resolves.toMatchObject({ exitCode: 0 });
    // The heart of it: reconciliation, not a second worker.
    expect(received.filter((request) => request.kind === 'start-turn')).toHaveLength(1);
    expect(telemetry.at(-1)).toMatchObject({ outcome: 'terminal', reconciled: true });
  });

  // The one case where re-sending is safe, and the two guarantees that make it so:
  // the supervisor never acknowledged the frame, so it holds no start it could run
  // later; and the frame is byte-identical, so its claim on `turnId` can only ever
  // adopt the turn — never open a second one. The mute first start is the shape a
  // supervisor that predates `startAck` presents (ADR 0006 D9).
  it('re-sends the identical frame once when nothing ever claimed the turn', async () => {
    const runtime = join(dir, 'never-claimed-runtime');
    await writeCompletedStream(join(runtime, 'turns', 'turn-1'));
    let starts = 0;
    const received = await serveSupervisor(runtime, (request, peer) => {
      if (request.kind === 'start-turn') {
        starts += 1;
        if (starts === 1) return;
        peer.end(`${JSON.stringify({ ok: true, outcome: 'created', state: state('running') })}\n`);
        return;
      }
      // Nothing owns the turn until the re-send arrives — which is the claim under
      // test, so the fixture is keyed on that and not on a poll count. It has to
      // stay empty for at least the client's missing-state floor, and does: the
      // client only re-sends once that floor has passed.
      peer.end(
        `${JSON.stringify(starts < 2 ? { ok: true } : { ok: true, state: state('settled') })}\n`,
      );
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      startAcceptTimeoutMs: 150,
      startTimeoutMs: 150,
    });
    const issuedAt = Date.now();
    await expect(startTurn(client).result).resolves.toMatchObject({ exitCode: 0 });
    const startFrames = received.filter((request) => request.kind === 'start-turn');
    expect(startFrames).toHaveLength(2);
    expect(startFrames[1]).toEqual(startFrames[0]);
    // And not before the floor: a run of quick empty reads against a responsive
    // supervisor is not yet evidence that nothing claimed the turn.
    expect(Date.now() - issuedAt).toBeGreaterThanOrEqual(START_TURN_MISSING_STATE_MIN_MS);
  });

  // And the other outcome of that same second look. A supervisor that predates
  // `startAck` never acknowledges anything, so a re-send it is merely slow to answer
  // used to fail bare — with the turn in fact started and this side sure it had none.
  // The state is still the witness: asked again, it says so, and the turn is adopted.
  it('adopts a re-sent start the state can still account for, instead of failing it', async () => {
    const runtime = join(dir, 'resend-then-running-runtime');
    await writeCompletedStream(join(runtime, 'turns', 'turn-1'));
    let starts = 0;
    const received = await serveSupervisor(runtime, (request, peer) => {
      if (request.kind === 'start-turn') {
        // Mute throughout: the legacy single-frame supervisor, too slow to answer.
        starts += 1;
        return;
      }
      // Nothing owns the turn until the re-send has gone out — which is what licenses
      // that re-send — and the second frame is what makes the turn appear.
      peer.end(
        `${JSON.stringify(starts < 2 ? { ok: true } : { ok: true, state: state('settled') })}\n`,
      );
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      startAcceptTimeoutMs: 150,
      startTimeoutMs: 150,
    });
    // The turn ran and ended while this side was still asking about it; its outcome
    // comes from the stream the second frame produced, not from a third attempt.
    await expect(startTurn(client).result).resolves.toMatchObject({ exitCode: 0 });
    // Twice, and never a third time: the adoption is what ends the sending.
    expect(received.filter((request) => request.kind === 'start-turn')).toHaveLength(2);
    expect(received.filter((request) => request.kind === 'cancel-turn')).toHaveLength(0);
  });

  // The re-send is the one frame that can leave a worker nobody is tailing, so its
  // failure must carry the uncertainty rather than an ordinary error: acknowledged
  // and then silent is the same unknown the first attempt fences for, and the fence
  // only fires on `start-uncertain`.
  it('fences a re-sent start the supervisor acknowledged and never reported', async () => {
    const runtime = join(dir, 'resend-then-silent-runtime');
    let starts = 0;
    const received = await serveSupervisor(runtime, (request, peer) => {
      if (request.kind === 'start-turn') {
        starts += 1;
        // Mute first (nothing to reconcile), then acknowledged and abandoned.
        if (starts >= 2) peer.write(acceptFrame(request));
        return;
      }
      if (request.kind === 'cancel-turn') {
        peer.end(`${JSON.stringify({ ok: true, outcome: 'cancelled' })}\n`);
        return;
      }
      peer.end(`${JSON.stringify({ ok: true })}\n`);
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      startAcceptTimeoutMs: 150,
      startTimeoutMs: 150,
    });
    const error = await startTurn(client).result.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(RunnerWorkerStartFailure);
    expect(error).toMatchObject({ reason: 'start-uncertain', turnId: 'turn-1' });
    expect(received.filter((request) => request.kind === 'start-turn')).toHaveLength(2);
    // The point of the reason: whatever the second frame may have started is told to
    // stop, instead of being left to run against a worktree the next turn will use.
    expect(received.filter((request) => request.kind === 'cancel-turn')).toEqual([
      expect.objectContaining({ turnId: 'turn-1' }),
    ]);
  });

  // The other half of that rule. Once the supervisor has acknowledged the frame it
  // owns the start — queued, claiming or spawning — and an empty turn directory
  // stops being evidence, because a start still waiting for a slot has written no
  // state yet. Re-sending there could leave a worker running with nobody tailing it.
  it('never re-sends a start the supervisor acknowledged, however little it says after', async () => {
    const runtime = join(dir, 'accepted-then-silent-runtime');
    const received = await serveSupervisor(runtime, (request, peer) => {
      if (request.kind === 'start-turn') {
        peer.write(acceptFrame(request));
        return;
      }
      // No state at all — under the unacknowledged rule this is what licenses a
      // re-send, and it must not license one here.
      peer.end(`${JSON.stringify({ ok: true })}\n`);
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      startTimeoutMs: 100,
      reconcileTimeoutMs: 200,
    });
    const error = await startTurn(client).result.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(RunnerWorkerStartFailure);
    expect(error).toMatchObject({ reason: 'start-uncertain', turnId: 'turn-1' });
    expect(received.filter((request) => request.kind === 'start-turn')).toHaveLength(1);
  });

  // A supervisor too old to acknowledge is not a supervisor that failed. Its silence
  // has to outlast the acceptance budget without costing the turn, so reconciliation
  // keeps watching until the start budget itself is gone.
  it('adopts a slow legacy start that never acknowledges, rather than failing it', async () => {
    const runtime = join(dir, 'slow-legacy-runtime');
    await writeCompletedStream(join(runtime, 'turns', 'turn-1'));
    let finished = false;
    const received = await serveSupervisor(runtime, (request, peer) => {
      if (request.kind === 'start-turn') {
        // Legacy: no acknowledgement, and the work takes longer than the acceptance
        // budget the new transport arms first.
        setTimeout(() => {
          finished = true;
        }, 120);
        return;
      }
      peer.end(`${JSON.stringify({ ok: true, state: state(finished ? 'settled' : 'claimed') })}\n`);
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      // The acceptance budget expires while the legacy start is still working; the
      // reconcile budget below is deliberately shorter than the start budget that
      // actually carries it.
      startAcceptTimeoutMs: 50,
      startTimeoutMs: 2_000,
      reconcileTimeoutMs: 20,
    });
    await expect(startTurn(client).result).resolves.toMatchObject({ exitCode: 0 });
    expect(received.filter((request) => request.kind === 'start-turn')).toHaveLength(1);
  });

  // A turn still `claimed` when the budget runs out may have a worker mid-spawn.
  // Re-sending into that is the duplicate-worker bug; failing closed is the price.
  it('fails closed rather than re-sending into a turn that is still being claimed', async () => {
    const runtime = join(dir, 'still-claimed-runtime');
    const received = await serveSupervisor(runtime, (request, peer) => {
      if (request.kind === 'start-turn') {
        peer.write(acceptFrame(request));
        return;
      }
      peer.end(`${JSON.stringify({ ok: true, state: state('claimed') })}\n`);
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      startTimeoutMs: 100,
      reconcileTimeoutMs: 300,
    });
    const error = await startTurn(client).result.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(RunnerWorkerStartFailure);
    expect(error).toMatchObject({ reason: 'start-uncertain', turnId: 'turn-1' });
    expect(received.filter((request) => request.kind === 'start-turn')).toHaveLength(1);
  });

  // Failing closed is only half of it. The turn this Server gave up on may still be
  // running an agent against the worktree, with nobody tailing its stream — the
  // orphan the operator saw as a session that never finished. Nothing else will
  // reach it: there is no local handle to cancel and no adoption path for a turn
  // whose start never returned, so the give-up itself has to fence it.
  it('fences an uncertain start with a cancel before giving up on it', async () => {
    const runtime = join(dir, 'uncertain-fence-runtime');
    const received = await serveSupervisor(runtime, (request, peer) => {
      if (request.kind === 'start-turn') {
        peer.write(acceptFrame(request));
        return;
      }
      if (request.kind === 'cancel-turn') {
        peer.end(`${JSON.stringify({ ok: true, outcome: 'cancelled' })}\n`);
        return;
      }
      peer.end(`${JSON.stringify({ ok: true, state: state('claimed') })}\n`);
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      startTimeoutMs: 100,
      reconcileTimeoutMs: 200,
    });
    const error = await startTurn(client).result.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({ reason: 'start-uncertain', turnId: 'turn-1' });
    // Sent before the failure surfaced, so a caller that reacts to the rejection by
    // starting the next turn cannot race the fence for the same worktree.
    expect(received.filter((request) => request.kind === 'cancel-turn')).toEqual([
      expect.objectContaining({ turnId: 'turn-1' }),
    ]);
  });

  // The mirror image, and the reason the fence is keyed on the reason rather than on
  // "the start failed": this turn belongs to a DIFFERENT start command. Cancelling it
  // would kill a live turn that is doing nothing wrong, on the strength of an id
  // collision this attempt lost.
  it('never fences a turn another start command owns', async () => {
    const runtime = join(dir, 'conflict-no-fence-runtime');
    const received = await serveSupervisor(runtime, (request, peer) => {
      if (request.kind === 'start-turn') return;
      peer.end(
        `${JSON.stringify({ ok: true, state: { ...state('running'), startCommandId: 'start-2' } })}\n`,
      );
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      startAcceptTimeoutMs: 50,
      startTimeoutMs: 100,
      reconcileTimeoutMs: 200,
    });
    await expect(startTurn(client).result).rejects.toThrow(/owned by another start command/u);
    expect(received.filter((request) => request.kind === 'cancel-turn')).toHaveLength(0);
  });

  // The acknowledgement is not a pleasantry: it re-arms a 100x longer budget and
  // marks the turn as the supervisor's property, which is what stops this side from
  // ever re-sending. One that names a different turn must not buy either.
  it('refuses an acknowledgement that names a different turn', async () => {
    const runtime = join(dir, 'mismatched-ack-runtime');
    const received = await serveSupervisor(runtime, (request, peer) => {
      if (request.kind === 'start-turn') {
        peer.write(
          `${JSON.stringify({ ok: true, kind: 'start-accepted', turnId: 'turn-other' })}\n`,
        );
        return;
      }
      peer.end(`${JSON.stringify({ ok: true })}\n`);
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      startAcceptTimeoutMs: 2_000,
      startTimeoutMs: 2_000,
      reconcileTimeoutMs: 50,
    });
    // Rejected on the frame itself, well inside the acceptance budget — not left to
    // expire against the result budget the bad acknowledgement tried to arm.
    const issuedAt = Date.now();
    await expect(startTurn(client).result).rejects.toThrow(/./u);
    expect(Date.now() - issuedAt).toBeLessThan(1_500);
    expect(received.filter((request) => request.kind === 'start-turn')).toHaveLength(1);
  });

  // A response too large to read is an answer this side FAILED to read, not a decision
  // the supervisor made — the start behind it may have succeeded perfectly. Classifying
  // it by matching the error text used to lump it in with a spoken refusal and fail the
  // turn outright; it is reconciled instead, and the running worker is adopted.
  it('reconciles a start whose response was too large to read, rather than failing it', async () => {
    const runtime = join(dir, 'oversize-response-runtime');
    await writeCompletedStream(join(runtime, 'turns', 'turn-1'));
    const received = await serveSupervisor(runtime, (request, peer) => {
      if (request.kind === 'start-turn') {
        peer.end(`${JSON.stringify({ ok: true, pad: 'x'.repeat(80 * 1024) })}\n`);
        return;
      }
      peer.end(`${JSON.stringify({ ok: true, state: state('settled') })}\n`);
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      startTimeoutMs: 500,
      reconcileTimeoutMs: 500,
    });
    await expect(startTurn(client).result).resolves.toMatchObject({ exitCode: 0 });
    // Adopted, never restarted: the worker the unreadable response was about.
    expect(received.filter((request) => request.kind === 'start-turn')).toHaveLength(1);
  });

  // The id collided: something else already owns `turnId` under a different start
  // command. Re-sending would hand this Server's tail to another attempt's stream,
  // and adopting would report that attempt's outcome as this turn's. Neither is
  // recoverable, so it fails under its own reason rather than as an uncertainty.
  it('refuses a turn another start command already owns', async () => {
    const runtime = join(dir, 'conflicting-owner-runtime');
    const received = await serveSupervisor(runtime, (request, peer) => {
      if (request.kind === 'start-turn') return;
      peer.end(
        `${JSON.stringify({ ok: true, state: { ...state('running'), startCommandId: 'start-2' } })}\n`,
      );
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      startAcceptTimeoutMs: 50,
      startTimeoutMs: 100,
      reconcileTimeoutMs: 200,
    });
    const error = await startTurn(client).result.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(RunnerWorkerStartFailure);
    expect(error).toMatchObject({ reason: 'start-conflict', turnId: 'turn-1' });
    expect(error).toHaveProperty(
      'message',
      expect.stringMatching(/owned by another start command/u),
    );
    // Decided on the first answer: no retry, and above all no second start frame.
    expect(received.filter((request) => request.kind === 'start-turn')).toHaveLength(1);
  });

  // What the operator actually read — `agent exited with code 1 without a terminal
  // event` — was this case with its diagnosis thrown away. The supervisor holds the
  // exit code, the signal and the stderr tail; they belong on the error.
  it('reports a worker that died before its first event as a structured failure', async () => {
    const runtime = join(dir, 'early-exit-runtime');
    await serve(join(runtime, 'supervisor.sock'), {
      ok: true,
      outcome: 'terminal',
      state: {
        ...state('settled'),
        workerExitCode: 1,
        workerSignal: null,
        workerError: 'codex: failed to open the ACP session',
      },
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
    });
    const error = await startTurn(client).result.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(RunnerWorkerStartFailure);
    expect(error).toMatchObject({
      reason: 'worker-exited-early',
      turnId: 'turn-1',
      workerExitCode: 1,
      workerError: 'codex: failed to open the ACP session',
    });
  });

  // Same shape as the trusted-CLI transport it borrows from: a supervisor that
  // cannot even say "heard you" is wedged, and must not consume the start budget.
  it('bounds a connected supervisor that never acknowledges the start', async () => {
    const runtime = join(dir, 'mute-runtime');
    await serveSupervisor(runtime, () => {
      // Deliberately silent — connected, reading, answering nothing.
    });
    const client = new SupervisorRunnerClient(backend, {
      runtimeDir: runtime,
      store,
      bus: new InMemoryEventBus(),
      // No accept, and `get-turn` is equally mute, so reconciliation runs out too.
      startAcceptTimeoutMs: 50,
      startTimeoutMs: 100,
      reconcileTimeoutMs: 200,
      timeoutMs: 50,
    });
    await expect(startTurn(client).result).rejects.toThrow(
      /did not answer whether turn turn-1 started/u,
    );
  });
});

describe('SupervisorRunnerRecovery marker preconditions', () => {
  // A marker this Server could not have written is not discoverable: the turn id
  // is interpolated into runtime paths, and a marker with no start command cannot
  // be matched against supervisor state. Neither may reach a lookup.
  it('keeps an unusable marker uncertain without any lookup', async () => {
    const getSession = vi.fn(async () => ({ projectId: 'project-1' }));
    const recovery = new SupervisorRunnerRecovery({ dataVolumeRoot: dir, getSession });

    await expect(
      recovery.discover({ sessionId: 's', turnId: 'turn-1', startCommandId: null }),
    ).resolves.toEqual({ status: 'uncertain' });
    await expect(
      recovery.discover({ sessionId: 's', turnId: '../escape', startCommandId: 'start-1' }),
    ).resolves.toEqual({ status: 'uncertain' });
    expect(getSession).not.toHaveBeenCalled();
  });
});
