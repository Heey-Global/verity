import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface DeadlineChannelTiming {
  queueMs: number;
  durationMs: number;
  startedBootNs: string;
  finishedBootNs: string;
  failed: boolean;
}

/** One private pipe pair; a broken channel is terminal until denied-state startup. */
export function createDeadlineChannel(
  launch: () => ChildProcessWithoutNullStreams = () =>
    spawn(
      '/usr/bin/python3',
      ['/opt/verity-egress/project-egress-deadline.py', '--serve', String(process.pid)],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', TZ: 'UTC' },
      },
    ),
  timeoutMs = 5000,
) {
  let child: ChildProcessWithoutNullStreams | undefined;
  let failure: Error | undefined;
  let sequence = 0;
  let queued = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let pending:
    | {
        id: number;
        queuedAt: number;
        dispatchedAt: number;
        observe?: (timing: DeadlineChannelTiming) => void;
        resolve(value: unknown): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let output = Buffer.alloc(0);
  let diagnostic = '';
  const close = (error = new Error('Host deadline channel closed')) => {
    failure ??= error;
    process.removeListener('exit', onExit);
    child?.kill('SIGKILL');
    child?.stdin.destroy();
    child?.stdout.destroy();
    child?.stderr.destroy();
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(failure);
      pending = undefined;
    }
  };
  const onExit = () => close();
  const start = () => {
    child = launch();
    process.once('exit', onExit);
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr])
      (stream as { unref?: () => void }).unref?.();
    child.on('error', close);
    child.stdin.on('error', close);
    child.stdout.on('error', close);
    child.stderr.on('error', close);
    child.once('exit', () => close(new Error('Host deadline helper exited: ' + diagnostic)));
    child.stdout.once('end', () => close(new Error('Host deadline helper EOF')));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      diagnostic = (diagnostic + chunk).slice(-8192);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (!pending) return close(new Error('Unsolicited host deadline response'));
      output = Buffer.concat([output, chunk]);
      if (output.length > 16384) return close(new Error('Oversized host deadline response'));
      const end = output.indexOf(10);
      if (end < 0) return;
      // No unsolicited or trailing frame can be mistaken for the next operation.
      if (!pending || end !== output.length - 1)
        return close(new Error('Unexpected host deadline response'));
      try {
        const reply: unknown = JSON.parse(output.subarray(0, end).toString('utf8'));
        if (!reply || typeof reply !== 'object' || !('id' in reply) || reply.id !== pending.id)
          throw new Error('Mismatched host deadline response');
        const timed = 'startedBootNs' in reply && 'finishedBootNs' in reply;
        if (
          timed &&
          (typeof reply.startedBootNs !== 'string' ||
            typeof reply.finishedBootNs !== 'string' ||
            !/^[0-9]{1,20}$/u.test(reply.startedBootNs) ||
            !/^[0-9]{1,20}$/u.test(reply.finishedBootNs) ||
            BigInt(reply.finishedBootNs) < BigInt(reply.startedBootNs))
        )
          throw new Error('Invalid host deadline timing');
        if (pending.observe && !timed) throw new Error('Missing host deadline timing');
        const keys = Object.keys(reply)
          .filter((key) => !timed || !['startedBootNs', 'finishedBootNs'].includes(key))
          .sort()
          .join(',');
        if (keys !== 'id,result' && keys !== 'error,id')
          throw new Error('Invalid host deadline response');
        if ('error' in reply && typeof reply.error !== 'string')
          throw new Error('Invalid host deadline error');
        const current = pending;
        if (timed)
          current.observe?.({
            queueMs: current.dispatchedAt - current.queuedAt,
            durationMs: performance.now() - current.queuedAt,
            startedBootNs: String(reply.startedBootNs),
            finishedBootNs: String(reply.finishedBootNs),
            failed: 'error' in reply,
          });
        pending = undefined;
        output = Buffer.alloc(0);
        clearTimeout(current.timer);
        if ('error' in reply)
          current.reject(
            new Error('Host packet deadline operation failed: ' + String(reply.error)),
          );
        else current.resolve('result' in reply ? reply.result : undefined);
      } catch (error) {
        close(error instanceof Error ? error : new Error('Invalid host deadline response'));
      }
    });
  };
  return {
    close: () => close(),
    request: (
      input: unknown,
      observe?: (timing: DeadlineChannelTiming) => void,
    ): Promise<unknown> => {
      const queuedAt = performance.now();
      if (failure) return Promise.reject(failure);
      if (queued >= 64) {
        const error = new Error('Host deadline queue capacity exceeded');
        close(error);
        return Promise.reject(error);
      }
      const id = ++sequence;
      const data = Buffer.from(JSON.stringify({ id, input }) + '\n');
      if (data.length > 65536) return Promise.reject(new Error('Oversized host deadline request'));
      queued++;
      const operation = queue.then(() => {
        if (failure) throw failure;
        if (!child) {
          try {
            start();
          } catch (error) {
            const reason =
              error instanceof Error ? error : new Error('Cannot start deadline helper');
            close(reason);
            throw reason;
          }
        }
        return new Promise<unknown>((resolve, reject) => {
          pending = {
            id,
            queuedAt,
            dispatchedAt: performance.now(),
            ...(observe ? { observe } : {}),
            resolve,
            reject,
            timer: setTimeout(
              () => close(new Error('Host deadline operation timed out')),
              timeoutMs,
            ),
          };
          child!.stdin.write(data);
        });
      });
      queue = operation.catch(() => undefined);
      return operation.finally(() => {
        queued--;
      });
    },
  };
}
