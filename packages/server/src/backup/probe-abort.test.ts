import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { decryptStream, encryptStream, generateBackupKeys } from './crypto.js';
import { BackupRepository } from './repository.js';
import { stageSnapshot } from './staging.js';

it('cancels a stalled encrypted stream and removes partially extracted staging on abort', async () => {
  const { host, recoveryKey } = await generateBackupKeys();
  const ciphertext = new Uint8Array(
    await new Response(
      await encryptStream(
        host.recipient,
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(128 * 1024));
            controller.close();
          },
        }),
      ),
    ).arrayBuffer(),
  );
  const controller = new AbortController();
  const cancelled = vi.fn();
  const source = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(ciphertext.subarray(0, 1024));
    },
    cancel: cancelled,
  });
  const plaintext = await decryptStream(recoveryKey, source, controller.signal);
  const reader = plaintext.getReader();
  const rejected = expect(reader.read()).rejects.toThrow();
  controller.abort();
  await rejected;
  expect(cancelled).toHaveBeenCalledOnce();
  reader.releaseLock();
  const root = await mkdtemp(join(tmpdir(), 'probe-abort-'));
  try {
    const repository = new BackupRepository(
      join(root, 'backup'),
      join(root, 'state'),
      randomUUID() + '-r1',
      host,
    );
    await repository.initialize();
    const manifest = await repository.capture(
      (async function* () {
        yield {
          path: 'one',
          mode: 0o600,
          source: (async function* () {
            yield new Uint8Array(128 * 1024);
          })(),
        };
      })(),
      { release: 'test', schema: 1, capturedAt: new Date().toISOString(), kind: 'manual' },
    );
    const stage = join(root, 'stage');
    await mkdir(stage);
    const abort = new AbortController();
    let checks = 0;
    vi.spyOn(abort.signal, 'throwIfAborted').mockImplementation(() => {
      if (++checks === 3) abort.abort();
      AbortSignal.prototype.throwIfAborted.call(abort.signal);
    });
    await expect(
      stageSnapshot(
        stage,
        join(root, 'backup', 'repositories'),
        manifest,
        recoveryKey,
        abort.signal,
      ),
    ).rejects.toThrow();
    expect(await readdir(stage)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
