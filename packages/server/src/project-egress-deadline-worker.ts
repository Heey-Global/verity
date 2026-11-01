import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';

const timestamp = z.string().regex(/^[0-9]{1,20}$/u);
const responseSchema = z.union([
  z.strictObject({
    id: z.number().int().positive(),
    result: z.unknown(),
    startedBootNs: timestamp,
    finishedBootNs: timestamp,
  }),
  z.strictObject({
    id: z.number().int().positive(),
    error: z.literal(true),
    startedBootNs: timestamp,
    finishedBootNs: timestamp,
  }),
]);
export interface DeadlineWorkerTiming {
  queueMs: number;
  durationMs: number;
  startedBootNs: string;
  finishedBootNs: string;
  failed: boolean;
}

interface Pending {
  id: number;
  frame: string;
  queuedAt: number;
  dispatchedAt: number;
  observe: ((timing: DeadlineWorkerTiming) => void) | undefined;
  validate(value: unknown): unknown;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Private pipes only. A failed operation is never replayed into a replacement worker. */
export function createProjectDeadlineWorker(
  launch: () => ChildProcessWithoutNullStreams = () =>
    spawn('/usr/bin/python3', ['/opt/verity-egress/project-egress-deadline.py', '--worker'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', TZ: 'UTC' },
    }),
  timeoutMs = 5000,
) {
  let child: ChildProcessWithoutNullStreams | undefined;
  let retiring = false;
  let stopped = false;
  let sequence = 0;
  let active: Pending | undefined;
  const queue: Pending[] = [];
  let output = Buffer.alloc(0);
  let diagnostic = '';
  const reject = (pending: Pending, error: Error) => {
    clearTimeout(pending.timer);
    pending.reject(error);
  };
  const fail = (error: Error) => {
    stopped = true;
    retiring = true;
    if (active) reject(active, error);
    active = undefined;
    for (const pending of queue.splice(0)) reject(pending, error);
    if (child?.pid) {
      // The fixed helper's subprocess mutations must die before a replacement can run.
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    } else child?.kill('SIGKILL');
  };
  const pump = () => {
    if (stopped || retiring || active || !queue.length) return;
    if (!child) {
      output = Buffer.alloc(0);
      diagnostic = '';
      const worker = launch();
      child = worker;
      worker.stderr.setEncoding('utf8');
      worker.stderr.on('data', (chunk: string) => {
        diagnostic = (diagnostic + chunk).slice(-8192);
      });
      worker.once('error', (error) => {
        if (!retiring && child === worker) fail(error);
      });
      worker.stdin.on('error', (error) => {
        if (!retiring && child === worker) fail(error);
      });
      worker.stdout.on('error', (error) => {
        if (!retiring && child === worker) fail(error);
      });
      worker.stdout.once('end', () => {
        if (!retiring) fail(new Error('Host deadline worker output ended'));
      });
      worker.once('close', () => {
        if (!retiring) fail(new Error('Host deadline worker exited: ' + diagnostic));
        child = undefined;
        retiring = false;
        try {
          pump();
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      worker.stdout.on('data', (chunk: Buffer) => {
        if (retiring) return;
        if (output.length + chunk.length > 16384)
          return fail(new Error('Oversized host deadline response'));
        output = Buffer.concat([output, chunk]);
        const end = output.indexOf(10);
        if (end < 0) return;
        // One response per outstanding request; unsolicited or coalesced replies are fatal.
        if (!active || end !== output.length - 1)
          return fail(new Error('Unexpected host deadline response'));
        const pending = active;
        try {
          const envelope = responseSchema.parse(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output.subarray(0, end))),
          );
          if (
            envelope.id !== pending.id ||
            BigInt(envelope.finishedBootNs) < BigInt(envelope.startedBootNs)
          )
            throw new Error('Mismatched host deadline response');
          const failed = 'error' in envelope;
          const result = failed ? undefined : pending.validate(envelope.result);
          pending.observe?.({
            queueMs: pending.dispatchedAt - pending.queuedAt,
            durationMs: performance.now() - pending.queuedAt,
            startedBootNs: envelope.startedBootNs,
            finishedBootNs: envelope.finishedBootNs,
            failed,
          });
          output = Buffer.alloc(0);
          active = undefined;
          clearTimeout(pending.timer);
          if (failed)
            pending.reject(new Error('Host packet deadline operation failed: ' + diagnostic));
          else pending.resolve(result);
          // Let write completion and any extra output settle before dispatching another request.
          setImmediate(pump);
        } catch (error) {
          fail(error instanceof Error ? error : new Error('Invalid host deadline response'));
        }
      });
    }
    active = queue.shift()!;
    active.dispatchedAt = performance.now();
    // No second frame is written until the reply arrives, bounding pipe backpressure.
    const writer = child;
    writer.stdin.write(active.frame, (error) => {
      if (error && !retiring && child === writer) fail(error);
    });
  };
  return {
    request(
      input: unknown,
      validate: (value: unknown) => unknown = (value) => value,
      observe?: (timing: DeadlineWorkerTiming) => void,
    ): Promise<unknown> {
      if (stopped) return Promise.reject(new Error('Host deadline worker is unavailable'));
      if (queue.length + Number(active !== undefined) >= 16)
        return Promise.reject(new Error('Host deadline worker queue is full'));
      const id = sequence + 1;
      const frame = JSON.stringify({ id, request: input }) + '\n';
      if (Buffer.byteLength(frame) > 65536)
        return Promise.reject(new Error('Oversized host deadline request'));
      sequence = id;
      return new Promise((resolve, rejectPromise) => {
        const pending: Pending = {
          id,
          frame,
          queuedAt: performance.now(),
          dispatchedAt: 0,
          observe,
          validate,
          resolve,
          reject: rejectPromise,
          timer: setTimeout(
            () => fail(new Error('Host deadline worker request timed out')),
            timeoutMs,
          ),
        };
        queue.push(pending);
        try {
          pump();
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    close(): void {
      stopped = true;
      fail(new Error('Host deadline worker is closed'));
    },
  };
}
