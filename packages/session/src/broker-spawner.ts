import { createConnection, type Socket } from 'node:net';
import { constants as osConstants } from 'node:os';
import type { SpawnedProcess, Spawner } from './backend-contract.js';

const PROTOCOL_VERSION = 1;
const MAX_STDERR_CHARS = 64 * 1024;
const STDOUT_HIGH_WATER_BYTES = 1024 * 1024;
const MAX_BROKER_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * The only part of {@link SpawnOptions.env} that crosses to the broker. The
 * broker builds the child environment from its OWN process env by allowlist, so
 * without this frame field Verity's per-turn runtime context — carried faithfully
 * from the Conductor through the supervisor client and re-validated by the runner
 * worker — was dropped at the last hop and never reached the agent. In-Sandbox
 * helpers such as `verity-code-review` read it to start a reviewer on this turn's
 * backend, so losing it silently mis-selected the reviewer.
 *
 * Forwarding the WHOLE environment would hand the broker (and through it the
 * agent) the caller's ambient env, which is exactly what the process split
 * exists to prevent — so only these two cross, and the broker re-checks that for
 * itself rather than trusting the frame. The same two keys are named in
 * `runner-worker-entry.ts` (guarding the request file) and in the broker; the
 * drift test in `broker-spawner.test.ts` keeps the three lists in step.
 */
export const SESSION_RUNTIME_ENV_KEYS = ['VERITY_SESSION_BACKEND', 'VERITY_SESSION_MODEL'] as const;

function sessionRuntimeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const key of SESSION_RUNTIME_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) forwarded[key] = value;
  }
  return forwarded;
}

class AsyncTextQueue implements AsyncIterable<string> {
  private readonly values: string[] = [];
  private readonly waiters: Array<(value: IteratorResult<string>) => void> = [];
  private ended = false;
  private queuedBytes = 0;

  constructor(
    private readonly pause: () => void,
    private readonly resume: () => void,
  ) {}

  push(value: string): boolean {
    if (this.ended) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else {
      this.values.push(value);
      this.queuedBytes += Buffer.byteLength(value);
      if (this.queuedBytes >= STDOUT_HIGH_WATER_BYTES) this.pause();
    }
    return this.queuedBytes < STDOUT_HIGH_WATER_BYTES;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) {
          this.queuedBytes -= Buffer.byteLength(value);
          if (this.queuedBytes < STDOUT_HIGH_WATER_BYTES / 2) this.resume();
          return { done: false, value };
        }
        if (this.ended) return { done: true, value: undefined };
        return await new Promise<IteratorResult<string>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function encode(data: string): string {
  return Buffer.from(data, 'utf8').toString('base64');
}

function decode(data: string): string {
  return Buffer.from(data, 'base64').toString('utf8');
}

function send(socket: Socket, frame: object): boolean {
  if (socket.destroyed || !socket.writable) return false;
  socket.write(`${JSON.stringify(frame)}\n`);
  return true;
}

export function createBrokerSpawner(socketPath: string): Spawner {
  const spawner: Spawner = (command, args, options): SpawnedProcess => {
    const socket = createConnection(socketPath);
    let processBuffered = (): void => undefined;
    const stdout = new AsyncTextQueue(
      () => socket.pause(),
      () => {
        socket.resume();
        queueMicrotask(processBuffered);
      },
    );
    let stderrTail = '';
    let pid: number | undefined;
    let spawned = false;
    let settled = false;
    let buffered = '';
    let pendingSignal: 'SIGTERM' | 'SIGKILL' | undefined;
    const pendingInput: string[] = options.stdin === undefined ? [] : [options.stdin];
    let stdinClosed = options.keepStdinOpen !== true;
    let resolveExited: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => (resolveExited = resolve));
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      stdout.end();
      socket.destroy();
      resolveExited(code);
    };
    const flushInput = (): void => {
      if (!spawned || settled) return;
      for (const data of pendingInput.splice(0)) {
        send(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'stdin', data: encode(data) });
      }
      if (stdinClosed) send(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'close-stdin' });
      if (pendingSignal !== undefined) {
        send(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'signal', signal: pendingSignal });
      }
    };

    socket.once('connect', () => {
      const sessionEnv = sessionRuntimeEnv(options.env);
      send(socket, {
        protocolVersion: PROTOCOL_VERSION,
        kind: 'spawn-agent',
        command,
        args,
        cwd: options.cwd,
        ...(Object.keys(sessionEnv).length > 0 ? { sessionEnv } : {}),
      });
    });
    processBuffered = (): void => {
      if (Buffer.byteLength(buffered) > MAX_BROKER_FRAME_BYTES && !buffered.includes('\n')) {
        stderrTail = 'spawn broker frame exceeded the size limit';
        settle(1);
        return;
      }
      for (;;) {
        if (settled) break;
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_BROKER_FRAME_BYTES) {
          stderrTail = 'spawn broker frame exceeded the size limit';
          settle(1);
          break;
        }
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          stderrTail = 'spawn broker returned malformed JSON';
          settle(1);
          break;
        }
        if (frame.ok !== true) {
          const error = typeof frame.error === 'string' ? frame.error : 'spawn broker failed';
          stderrTail = `${stderrTail}${stderrTail ? '\n' : ''}${error}`.slice(-MAX_STDERR_CHARS);
          settle(1);
        } else if (frame.kind === 'spawned') {
          spawned = true;
          pid = typeof frame.pid === 'number' ? frame.pid : undefined;
          flushInput();
        } else if (frame.kind === 'stdout' && typeof frame.data === 'string') {
          if (!stdout.push(decode(frame.data))) break;
        } else if (frame.kind === 'stderr' && typeof frame.data === 'string') {
          stderrTail = `${stderrTail}${decode(frame.data)}`.slice(-MAX_STDERR_CHARS);
        } else if (frame.kind === 'exit') {
          const signalNumber =
            typeof frame.signal === 'string'
              ? (osConstants.signals as Record<string, number>)[frame.signal]
              : undefined;
          settle(typeof frame.code === 'number' ? frame.code : 128 + (signalNumber ?? 0));
        }
      }
    };
    socket.on('data', (chunk) => {
      if (settled) return;
      buffered += chunk.toString('utf8');
      processBuffered();
    });
    socket.once('error', (error) => {
      stderrTail = `${stderrTail}${stderrTail ? '\n' : ''}${error.message}`.slice(
        -MAX_STDERR_CHARS,
      );
      settle(1);
    });
    socket.once('close', () => {
      if (!settled) {
        if (Buffer.byteLength(buffered) > MAX_BROKER_FRAME_BYTES) {
          stderrTail = 'spawn broker frame exceeded the size limit';
        }
        settle(1);
      }
    });

    return {
      stdout,
      get pid() {
        return pid;
      },
      exited,
      stderr: () => stderrTail,
      kill: (signal = 'SIGTERM') => {
        if (signal !== 'SIGTERM' && signal !== 'SIGKILL') return;
        if (!spawned) pendingSignal = signal;
        else send(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'signal', signal });
      },
      writeStdin: (data) => {
        if (stdinClosed || settled) return false;
        if (!spawned) pendingInput.push(data);
        else
          return send(socket, {
            protocolVersion: PROTOCOL_VERSION,
            kind: 'stdin',
            data: encode(data),
          });
        return true;
      },
      closeStdin: () => {
        if (stdinClosed) return;
        stdinClosed = true;
        if (spawned) send(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'close-stdin' });
      },
    };
  };
  return spawner;
}
