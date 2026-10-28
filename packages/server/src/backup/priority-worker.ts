import { parentPort } from 'node:worker_threads';
import { createHmac, randomBytes } from 'node:crypto';
import { setPriority, getPriority } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readlinkSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  linkSync,
  renameSync,
  rmSync,
  constants,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { Encrypter } from 'age-encryption';

// Linux priorities are per native thread. Never renice process.pid (the Server's main thread).
setPriority(0, 19);
const tid = Number(readlinkSync('/proc/thread-self').split('/').at(-1));
let idleIO = false;
if (existsSync('/usr/bin/ionice')) {
  try {
    execFileSync('/usr/bin/ionice', ['-c', '3', '-p', String(tid)], {
      stdio: 'ignore',
      timeout: 5000,
    });
    idleIO = true;
  } catch {
    /* Idle IO is optional on filesystems/kernels that do not support it. */
  }
}
parentPort!.postMessage({ ready: true, nice: getPriority(0), tid, idleIO });
const handle = async (job: {
  id: number;
  kind: string;
  bytes: Uint8Array;
  key?: string;
  path?: string;
  immutable?: boolean;
  fd?: number;
}) => {
  try {
    let result: unknown;
    if (job.kind === 'fingerprint') {
      result = createHmac('sha256', Buffer.from(job.key!, 'base64url'))
        .update(job.bytes)
        .digest('hex');
    } else if (job.kind === 'encrypt') {
      const encrypter = new Encrypter();
      encrypter.addRecipient(job.key!);
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(job.bytes);
          c.close();
        },
      });
      result = new Uint8Array(await new Response(await encrypter.encrypt(stream)).arrayBuffer());
    } else if (job.kind === 'file') {
      writeFileSync(job.fd!, job.bytes);
    } else if (job.kind === 'write') {
      const path = job.path!;
      const temporary = join(dirname(path), `.pending-${randomBytes(16).toString('hex')}`);
      try {
        const fd = openSync(temporary, 'wx', 0o600);
        try {
          writeFileSync(fd, job.bytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        if (job.immutable) linkSync(temporary, path);
        else renameSync(temporary, path);
        const directory = openSync(
          dirname(path),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      } finally {
        rmSync(temporary, { force: true });
      }
    } else throw new Error('Unknown backup work');
    parentPort!.postMessage({ id: job.id, result });
  } catch (error) {
    parentPort!.postMessage({
      id: job.id,
      error: true,
      code: (error as NodeJS.ErrnoException).code,
    });
  }
};
parentPort!.on('message', (job: Parameters<typeof handle>[0]) => {
  void handle(job);
});
