import { getPriority } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { BackupWork, backupCommand, withBackupWork } from './priority.js';
import { writeDurable } from './repository.js';
import { decryptStream, generateBackupKeys } from './crypto.js';

it('prioritizes only its worker and subprocesses, with bounded encrypted work and durable IO', async () => {
  const before = getPriority();
  const work = new BackupWork();
  const root = await mkdtemp(join(tmpdir(), 'backup-priority-'));
  try {
    const ready = await work.ready;
    expect(ready.nice).toBe(19);
    expect(getPriority()).toBe(before);
    expect(ready.tid).not.toBe(process.pid);
    if (ready.idleIO)
      expect(
        execFileSync('/usr/bin/ionice', ['-p', String(ready.tid)], { encoding: 'utf8' }).trim(),
      ).toBe('idle');
    const { host, recoveryKey } = await generateBackupKeys();
    const bytes = randomBytes(1024 * 1024);
    const encrypted = (await work.call('encrypt', bytes, { key: host.recipient })) as Uint8Array;
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encrypted);
        c.close();
      },
    });
    expect(
      Buffer.from(await new Response(await decryptStream(recoveryKey, source)).arrayBuffer()),
    ).toEqual(bytes);
    await expect(
      work.call('encrypt', new Uint8Array(32 * 1024 * 1024 + 1), { key: host.recipient }),
    ).rejects.toThrow('budget');
    await withBackupWork(() => writeDurable(join(root, 'object'), bytes, true));
    expect(await readFile(join(root, 'object'))).toEqual(bytes);
    const [command, args] = backupCommand('/bin/sh', ['-c', 'ps -o ni= -p $$']);
    expect(Number(execFileSync(command, args, { encoding: 'utf8' }).trim())).toBe(19);
    expect(getPriority()).toBe(before);
  } finally {
    await work.close();
    await rm(root, { recursive: true, force: true });
  }
});
