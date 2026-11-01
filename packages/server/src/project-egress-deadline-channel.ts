import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Socket } from 'node:net';
import { z } from 'zod';

/** One private child; transport failure is terminal until the host is reconstructed. */
export function createDeadlineChannel(
  launch: () => ChildProcessWithoutNullStreams = () =>
    spawn('/usr/bin/python3', ['/opt/verity-egress/project-egress-deadline.py', '--serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', TZ: 'UTC' },
    }),
  timeoutMs = 5000,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000)
    throw new Error('Invalid deadline channel timeout');
  let child: ChildProcessWithoutNullStreams | undefined;
  let failure: Error | undefined;
  let sequence = 0;
  let queued = 0;
  let tail: Promise<unknown> = Promise.resolve();
  let output = '';
  let diagnostic = '';
  let pending:
    | {
        id: number;
        resolve(value: unknown): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(failure);
      pending = undefined;
    }
    child?.kill('SIGKILL');
  };
  const close = () => fail(new Error('Host deadline channel closed'));
  const start = () => {
    child = launch();
    // An idle helper must not own the lifetime of the host or disposable probes.
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as Socket).unref();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      diagnostic = (diagnostic + chunk).slice(-8192);
    });
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stderr.on('error', fail);
    child.once('close', () => fail(new Error('Host deadline helper exited: ' + diagnostic)));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output) > 16384)
        return fail(new Error('Oversized host deadline response'));
      if (!output.includes('\n')) return;
      const frame = output;
      output = '';
      try {
        if (!frame.endsWith('\n') || frame.indexOf('\n') !== frame.length - 1 || !pending)
          throw new Error('Unexpected host deadline frame');
        const reply = z
          .union([
            z.strictObject({ id: z.number().int().positive(), result: z.unknown() }),
            z.strictObject({ id: z.number().int().positive(), error: z.string().max(4096) }),
          ])
          .parse(JSON.parse(frame));
        if (reply.id !== pending.id) throw new Error('Mismatched host deadline sequence');
        const current = pending;
        clearTimeout(current.timer);
        pending = undefined;
        if ('error' in reply)
          current.reject(new Error('Host packet deadline operation failed: ' + reply.error));
        else current.resolve(reply.result);
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Invalid deadline frame'));
      }
    });
    process.once('exit', close);
  };
  return {
    close() {
      process.removeListener('exit', close);
      close();
    },
    request(input: unknown): Promise<unknown> {
      if (queued >= 32) return Promise.reject(new Error('Host deadline queue full'));
      queued++;
      const run = async () => {
        if (failure) throw failure;
        const id = sequence + 1;
        if (!Number.isSafeInteger(id)) throw new Error('Host deadline sequence exhausted');
        const frame = JSON.stringify({ id, request: input }) + '\n';
        if (Buffer.byteLength(frame) > 65536) throw new Error('Oversized host deadline request');
        sequence = id;
        if (!child) {
          try {
            start();
          } catch (error) {
            const cause = error instanceof Error ? error : new Error('Host deadline launch failed');
            fail(cause);
            throw cause;
          }
        }
        return new Promise<unknown>((resolve, reject) => {
          pending = {
            id,
            resolve,
            reject,
            timer: setTimeout(() => fail(new Error('Host deadline helper timed out')), timeoutMs),
          };
          child!.stdin.write(frame);
        });
      };
      const result = tail.then(run);
      tail = result.catch(() => undefined);
      return result.finally(() => {
        queued--;
      });
    },
  };
}
