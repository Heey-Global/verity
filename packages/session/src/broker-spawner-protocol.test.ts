import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrokerSpawner } from './broker-spawner.js';

let runtimeDir: string;

beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), 'verity-agent-broker-'));
  await chmod(runtimeDir, 0o770);
});

afterEach(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});

/**
 * The client half of the broker protocol, driven against a scripted peer.
 *
 * The tests above run the REAL broker, which only ever speaks the protocol
 * correctly: it cannot emit a malformed frame, a refusal without a reason, an exit
 * reported as a bare signal, or a socket that closes with no `exit` frame at all.
 * Those are precisely the cases {@link createBrokerSpawner} classifies into an exit
 * code plus a stderr tail, and getting one wrong turns a broken turn into a silently
 * "clean" exit. A scripted peer is the only way to produce them deterministically.
 */
interface ScriptedBroker {
  socketPath: string;
  /** Every frame the spawner wrote, in order. */
  readonly requests: Record<string, unknown>[];
  /** Resolves with the `spawn-agent` frame once the spawner has sent it. */
  readonly spawnRequest: Promise<Record<string, unknown>>;
  /** Write raw bytes to the connected spawner (one `write` = one wire chunk). */
  write: (text: string) => void;
  /** Write the given frames as one chunk of newline-delimited JSON. */
  send: (...frames: unknown[]) => void;
  /** Half-close the connection without sending anything further. */
  end: () => void;
}

const scriptedBrokers: Array<() => Promise<void>> = [];

/** Snapshotted at import, before any test reassigns `TMPDIR`: a unix socket path
 * is capped at ~104 bytes, and the scratch-cleanup tests above repoint `TMPDIR`
 * into a nested temporary tree. Binding under the original root keeps these paths
 * short no matter what ran first. */
const SCRIPTED_TMP_ROOT = tmpdir();

let scriptedDir: string;

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

async function startScriptedBroker(
  capabilities: Record<string, unknown> = {
    managedAgentConfig: true,
    planningIsolation: true,
    gatewayToolsOnlyVersion: 1,
  },
): Promise<ScriptedBroker> {
  const socketPath = join(scriptedDir, `scripted-${randomUUID().slice(0, 8)}.sock`);
  const requests: Record<string, unknown>[] = [];
  let peer: Socket | undefined;
  let announceSpawn: (frame: Record<string, unknown>) => void = () => undefined;
  const spawnRequest = new Promise<Record<string, unknown>>((resolve) => {
    announceSpawn = resolve;
  });
  let buffered = '';
  const server = createServer((socket) => {
    peer = socket;
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const frame = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
        buffered = buffered.slice(newline + 1);
        requests.push(frame);
        if (frame.kind === 'status')
          socket.end(JSON.stringify({ ok: true, ...capabilities }) + '\n');
        if (frame.kind === 'spawn-agent') {
          peer = socket;
          announceSpawn(frame);
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  scriptedBrokers.push(
    () =>
      new Promise<void>((resolve) => {
        peer?.destroy();
        server.close(() => resolve());
      }),
  );
  return {
    socketPath,
    requests,
    spawnRequest,
    write: (text) => void peer?.write(text),
    send: (...frames) => void peer?.write(frames.map((f) => `${JSON.stringify(f)}\n`).join('')),
    end: () => void peer?.end(),
  };
}

describe('broker spawner protocol handling', () => {
  beforeEach(async () => {
    scriptedDir = await mkdtemp(join(SCRIPTED_TMP_ROOT, 'verity-broker-peer-'));
  });

  afterEach(async () => {
    await Promise.all(scriptedBrokers.splice(0).map((close) => close()));
    await rm(scriptedDir, { recursive: true, force: true });
  });

  /** Connect the spawner to `broker` and wait until its `spawn-agent` frame lands. */
  async function connect(
    broker: ScriptedBroker,
    options: {
      keepStdinOpen?: boolean;
      stdin?: string;
      planning?: boolean;
      gatewayToolsOnly?: boolean;
    } = {},
  ) {
    const handle = createBrokerSpawner(broker.socketPath)('claude-agent-acp', [], {
      cwd: scriptedDir,
      env: {},
      ...options,
    });
    await broker.spawnRequest;
    return handle;
  }

  it('carries planning isolation through the broker frame', async () => {
    const broker = await startScriptedBroker();
    const handle = await connect(broker, { planning: true });
    expect(await broker.spawnRequest).toMatchObject({ planning: true });
    broker.send({ ok: true, kind: 'exit', code: 0 });
    await handle.exited;
  });

  it('carries native tool isolation through the broker frame', async () => {
    const broker = await startScriptedBroker();
    const handle = await connect(broker, { gatewayToolsOnly: true });
    expect(await broker.spawnRequest).toMatchObject({ gatewayToolsOnly: true });
    broker.send({ ok: true, kind: 'exit', code: 0 });
    await handle.exited;
  });

  it('refuses tool isolation on a broker that only supports managed homes', async () => {
    const broker = await startScriptedBroker({ managedAgentConfig: true });
    const handle = createBrokerSpawner(broker.socketPath)('codex-acp', [], {
      cwd: scriptedDir,
      env: {},
      gatewayToolsOnly: true,
      gatewayToolsModel: 'codex/gpt-6.1',
    });
    await expect(handle.exited).resolves.toBe(1);
    expect(broker.requests.some((frame) => frame.kind === 'spawn-agent')).toBe(false);
  });

  it('refuses a stale broker without starting an agent', async () => {
    const broker = await startScriptedBroker({});
    const handle = createBrokerSpawner(broker.socketPath, true)('claude-agent-acp', [], {
      cwd: scriptedDir,
      env: {},
    });
    await expect(handle.exited).resolves.toBe(1);
    expect(handle.stderr()).toContain('update the Sandbox toolkit');
    expect(broker.requests.some((frame) => frame.kind === 'spawn-agent')).toBe(false);
  });

  it('retains the latest 64 KiB of broker stderr bytes', async () => {
    const broker = await startScriptedBroker();
    const handle = await connect(broker);
    broker.send(
      { ok: true, kind: 'stderr', data: base64('old' + 'é'.repeat(40000) + 'END') },
      { ok: true, kind: 'exit', code: 1, signal: null },
    );
    await expect(handle.exited).resolves.toBe(1);
    expect(handle.stderr()).toBe('é'.repeat(32766) + 'END');
    expect(handle.exitDetails?.()).toEqual({ code: 1, signal: null });
  });

  // A broker that answers with something other than JSON is a broker whose own
  // framing broke. Reporting the last agent diagnostic instead would blame the
  // agent for the transport's failure, so the tail is REPLACED, not appended to.
  it('replaces the stderr tail with the malformed-frame diagnostic', async () => {
    const broker = await startScriptedBroker();
    const handle = await connect(broker);

    broker.write(
      `${JSON.stringify({ ok: true, kind: 'stderr', data: base64('agent diagnostic') })}\nnot-json\n`,
    );

    await expect(handle.exited).resolves.toBe(1);
    expect(handle.stderr()).toBe('spawn broker returned malformed JSON');
  });

  // The first refusal settles the request. Frames coalesced behind it must not
  // mutate the settled handle or be interpreted as belonging to this spawn.
  it('stops parsing a coalesced chunk after the first refusal', async () => {
    const broker = await startScriptedBroker();
    const handle = await connect(broker);

    broker.send(
      { ok: false, error: 'invalid agent spawn request' },
      { ok: false },
      { ok: true, kind: 'exit', code: 42 },
    );

    await expect(handle.exited).resolves.toBe(1);
    expect(handle.stderr()).toBe('invalid agent spawn request');
  });

  // POSIX 128+signum, so a killed agent is never reported as a clean 0. An
  // unrecognised signal name has no number, and must not silently become one.
  it('maps a signal-only exit to 128 + the signal number', async () => {
    const killed = await startScriptedBroker();
    const killedHandle = await connect(killed);
    killed.send(
      { ok: true, kind: 'spawned', pid: 4242 },
      { ok: true, kind: 'exit', signal: 'SIGKILL' },
    );
    await expect(killedHandle.exited).resolves.toBe(137);
    expect(killedHandle.pid).toBe(4242);
    expect(killedHandle.exitDetails?.()).toEqual({ code: null, signal: 'SIGKILL' });

    const unknown = await startScriptedBroker();
    const unknownHandle = await connect(unknown);
    unknown.send({ ok: true, kind: 'spawned' }, { ok: true, kind: 'exit', signal: 'SIGNOTREAL' });
    await expect(unknownHandle.exited).resolves.toBe(128);
    expect(unknownHandle.pid).toBeUndefined();
  });

  // No socket means no turn. The OS error is the only diagnostic that exists, and
  // dropping it leaves a failed turn with an empty stderr and exit 1.
  it('reports the connection error when the broker socket is unreachable', async () => {
    const handle = createBrokerSpawner(join(scriptedDir, 'no-such-broker.sock'))(
      'claude-agent-acp',
      [],
      {
        cwd: scriptedDir,
        env: {},
      },
    );

    await expect(handle.exited).resolves.toBe(1);
    expect(handle.stderr()).toMatch(/ENOENT.*no-such-broker\.sock/u);
  });

  it('settles a connection the broker closed without an exit frame', async () => {
    const broker = await startScriptedBroker();
    const handle = await connect(broker);

    broker.end();

    await expect(handle.exited).resolves.toBe(1);
    // Empty: this is the close path, not the socket-error path.
    expect(handle.stderr()).toBe('');
  });

  it('reports an oversized unterminated final broker frame', async () => {
    const broker = await startScriptedBroker();
    const handle = await connect(broker);
    broker.write('x'.repeat(8 * 1024 * 1024 + 1));
    broker.end();
    await expect(handle.exited).resolves.toBe(1);
    expect(handle.stderr()).toBe('spawn broker frame exceeded the size limit');
  });

  it('rejects an oversized broker frame even when newline terminated', async () => {
    const broker = await startScriptedBroker();
    const handle = await connect(broker);
    broker.write(`${'x'.repeat(8 * 1024 * 1024 + 1)}\n`);
    await expect(handle.exited).resolves.toBe(1);
    expect(handle.stderr()).toBe('spawn broker frame exceeded the size limit');
  });

  // A cancel that lands between `spawn-agent` and `spawned` has nothing to signal
  // yet. Dropping it would leave the agent running with the Server believing it
  // cancelled the turn, so the signal is parked and replayed on spawn.
  it('parks a pre-spawn kill until the child exists and ignores an unsupported signal', async () => {
    const broker = await startScriptedBroker();
    const handle = await connect(broker);

    // SIGHUP is not a signal this transport carries; parking it would overwrite the
    // real cancel that arrived first.
    handle.kill('SIGKILL');
    handle.kill('SIGHUP');
    expect(broker.requests.map((frame) => frame.kind)).toEqual(['spawn-agent']);

    broker.send({ ok: true, kind: 'spawned', pid: 77 });
    await vi.waitFor(() => expect(broker.requests).toHaveLength(3));
    expect(broker.requests.slice(1)).toEqual([
      { protocolVersion: 1, kind: 'close-stdin' },
      { protocolVersion: 1, kind: 'signal', signal: 'SIGKILL' },
    ]);

    // Once spawned, a signal goes straight out — and the default is SIGTERM.
    handle.kill();
    await vi.waitFor(() => expect(broker.requests).toHaveLength(4));
    expect(broker.requests[3]).toEqual({ protocolVersion: 1, kind: 'signal', signal: 'SIGTERM' });
  });

  // Steering input (#101) rides the same socket. What must never happen is a write
  // after EOF being reported as accepted: the caller would drop a message it was
  // told had been delivered.
  it('streams stdin through after spawn and refuses it once stdin is closed', async () => {
    const broker = await startScriptedBroker();
    const handle = await connect(broker, { keepStdinOpen: true });

    expect(handle.writeStdin?.('queued ')).toBe(true);
    broker.send({ ok: true, kind: 'spawned', pid: 7 });
    await vi.waitFor(() => expect(broker.requests).toHaveLength(2));

    expect(handle.writeStdin?.('live')).toBe(true);
    await vi.waitFor(() => expect(broker.requests).toHaveLength(3));

    handle.closeStdin?.();
    await vi.waitFor(() => expect(broker.requests).toHaveLength(4));
    // Idempotent: a second close is not a second EOF frame.
    handle.closeStdin?.();
    expect(handle.writeStdin?.('after close')).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(broker.requests.slice(1)).toEqual([
      { protocolVersion: 1, kind: 'stdin', data: base64('queued ') },
      { protocolVersion: 1, kind: 'stdin', data: base64('live') },
      { protocolVersion: 1, kind: 'close-stdin' },
    ]);
  });

  // An agent that outruns its reader would otherwise queue its whole stdout in
  // this process's heap. Past the high-water mark the socket stops being read, so
  // the backlog is held in the kernel — which also means nothing behind it (here,
  // the turn's `exit`) is processed until the consumer catches up.
  it('stops reading the broker socket past the stdout high-water mark', async () => {
    const broker = await startScriptedBroker();
    const handle = await connect(broker);
    const payload = 'x'.repeat(1024 * 1024 + 1);

    broker.send(
      { ok: true, kind: 'spawned', pid: 9 },
      { ok: true, kind: 'stdout', data: base64(payload) },
    );
    // Let the whole frame land and the queue trip its high-water mark before the
    // next frame is written, so `exit` is behind a socket that is no longer read.
    await new Promise((resolve) => setTimeout(resolve, 250));
    broker.send({ ok: true, kind: 'exit', code: 7 });

    await expect(
      Promise.race([
        handle.exited,
        new Promise((resolve) => setTimeout(() => resolve('still-paused'), 250)),
      ]),
    ).resolves.toBe('still-paused');

    const chunks: string[] = [];
    for await (const chunk of handle.stdout) chunks.push(chunk);
    expect(chunks).toEqual([payload]);
    await expect(handle.exited).resolves.toBe(7);
  });

  it('preserves UTF-8 characters split across broker stdout frames', async () => {
    const broker = await startScriptedBroker();
    const handle = await connect(broker);
    const bytes = Buffer.from('Plötzlich größer', 'utf8');
    const split = bytes.indexOf(0xc3) + 1;

    broker.send(
      { ok: true, kind: 'spawned', pid: 10 },
      { ok: true, kind: 'stdout', data: bytes.subarray(0, split).toString('base64') },
      { ok: true, kind: 'stdout', data: bytes.subarray(split).toString('base64') },
      { ok: true, kind: 'exit', code: 0 },
    );

    const chunks: string[] = [];
    for await (const chunk of handle.stdout) chunks.push(chunk);
    await expect(handle.exited).resolves.toBe(0);
    expect(chunks.join('')).toBe('Plötzlich größer');
  });

  // The turn ends at its `exit` frame. Anything the broker wrote after it belongs
  // to no turn and must not reach the consumer, or a settled turn's transcript
  // grows output nobody can attribute.
  it('drops stdout written after the exit frame and then reports the stream done', async () => {
    const broker = await startScriptedBroker();
    const handle = await connect(broker);

    broker.send(
      { ok: true, kind: 'spawned', pid: 3 },
      { ok: true, kind: 'stdout', data: base64('before') },
      { ok: true, kind: 'exit', code: 5 },
      { ok: true, kind: 'stdout', data: base64('after') },
      { ok: true, kind: 'exit', code: 9 },
    );

    await expect(handle.exited).resolves.toBe(5);
    const chunks: string[] = [];
    for await (const chunk of handle.stdout) chunks.push(chunk);
    expect(chunks).toEqual(['before']);
  });
});
