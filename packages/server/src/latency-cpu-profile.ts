import { Session } from 'node:inspector';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

interface ProfileSession {
  connect(): void;
  disconnect(): void;
  post(
    method: 'Profiler.enable' | 'Profiler.start' | 'Profiler.stop' | 'Profiler.disable',
  ): Promise<{ profile?: unknown }>;
}

export interface LatencyCpuProfilerOptions {
  directory?: string | undefined;
  log: (event: { event: 'saved' | 'failed'; file?: string; stage?: string }) => void;
  createSession?: () => ProfileSession;
  now?: () => number;
  mkdir?: typeof mkdir;
  writeFile?: typeof writeFile;
}

/** Opt-in local profiling: no inspector listener or remote debugger endpoint. */
export function createLatencyCpuProfiler(options: LatencyCpuProfilerOptions): {
  trigger: (eventLoopDelayMs: number) => void;
  close: () => Promise<void>;
} {
  let closed = false;
  let active: Promise<void> | undefined;
  let nextAllowed = 0;
  let attempts = 0;
  let cancelWait: (() => void) | undefined;
  const now = options.now ?? Date.now;
  const createSession =
    options.createSession ??
    (() => {
      const session = new Session();
      return {
        connect: () => session.connect(),
        disconnect: () => session.disconnect(),
        post: (method) =>
          new Promise<{ profile?: unknown }>((resolve, reject) => {
            session.post(method, (error, result) =>
              error ? reject(error) : resolve(result ?? {}),
            );
          }),
      };
    });
  async function capture(): Promise<void> {
    let session: ProfileSession | undefined;
    let connected = false;
    let started = false;
    let stage = 'connect';
    try {
      session = createSession();
      session.connect();
      connected = true;
      stage = 'start';
      await session.post('Profiler.enable');
      if (closed) return;
      await session.post('Profiler.start');
      started = true;
      if (!closed)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(finish, 5_000);
          timer.unref();
          function finish(): void {
            clearTimeout(timer);
            cancelWait = undefined;
            resolve();
          }
          cancelWait = finish;
        });
      stage = 'stop';
      const result = await session.post('Profiler.stop');
      started = false;
      if (closed) return;
      if (!result.profile) throw new Error('Missing profile');
      stage = 'size';
      const serialized = JSON.stringify(result.profile);
      if (Buffer.byteLength(serialized) > 8 * 1024 * 1024) throw new Error('Profile too large');
      stage = 'write';
      const directory = options.directory!;
      await (options.mkdir ?? mkdir)(directory, { recursive: true, mode: 0o700 });
      if (closed) return;
      const file = join(directory, `latency-${randomUUID()}.cpuprofile`);
      await (options.writeFile ?? writeFile)(file, serialized, {
        mode: 0o600,
        flag: 'wx',
      });
      options.log({ event: 'saved', file });
    } catch {
      options.log({ event: 'failed', stage });
    } finally {
      if (session && connected) {
        if (started) {
          try {
            await session.post('Profiler.stop');
          } catch {
            /* Disconnect also ends this local session. */
          }
        }
        try {
          await session.post('Profiler.disable');
        } catch {
          /* Cleanup remains best effort. */
        }
        try {
          session.disconnect();
        } catch {
          /* Closing diagnostics must not reject application shutdown. */
        }
      }
    }
  }
  return {
    trigger(delay) {
      if (
        !options.directory ||
        attempts >= 3 ||
        closed ||
        active ||
        delay < 500 ||
        now() < nextAllowed
      )
        return;
      attempts += 1;
      nextAllowed = now() + 300_000;
      active = capture().finally(() => {
        active = undefined;
      });
    },
    async close() {
      closed = true;
      cancelWait?.();
      await active;
    },
  };
}
