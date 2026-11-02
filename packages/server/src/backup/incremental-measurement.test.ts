import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { generateBackupKeys } from './crypto.js';
import { captureTree } from './filesystem.js';
import { BackupRepository, restoreFile } from './repository.js';

it('measures actual destination bytes for full, unchanged and small-edit captures', async () => {
  // Workspace storage avoids filling a small system tmpfs. The fixture is bounded at 8 MiB.
  const parent = join(process.cwd(), '.cache');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'backup-measurement-'));
  const source = join(root, 'source');
  const destination = join(root, 'backup');
  await mkdir(source);
  const data = createHash('shake256', { outputLength: 8 * 1024 * 1024 })
    .update('backup-measurement-v1')
    .digest();
  const { host, recoveryKey } = await generateBackupKeys();
  const repository = new BackupRepository(
    destination,
    join(root, 'state'),
    `${randomUUID()}-r1`,
    host,
  );
  const measured: {
    phase: string;
    newlyWrittenObjectBytes: number;
    retainedObjectBytes: number;
    newlyWrittenDestinationBytes: number;
    retainedDestinationBytes: number;
    elapsedMs: number;
    cpuMicros: number;
    maxRssKiB: number;
  }[] = [];
  const destinationFiles = async () => {
    const result = new Map<string, { bytes: number; hash: string }>();
    const visit = async (path: string) => {
      for (const name of await readdir(path)) {
        const child = join(path, name);
        const info = await stat(child);
        if (info.isDirectory()) await visit(child);
        else
          result.set(child, {
            bytes: info.size,
            hash: createHash('sha256')
              .update(await readFile(child))
              .digest('hex'),
          });
      }
    };
    await visit(destination);
    return result;
  };
  try {
    await repository.initialize();
    for (const phase of ['full', 'unchanged', 'small-edit']) {
      if (phase === 'small-edit') data.fill(0x42, 4 * 1024 * 1024, 4 * 1024 * 1024 + 32);
      await writeFile(join(source, 'payload'), data);
      const before = new Set(await readdir(join(repository.root, 'objects')));
      const previousDestination = await destinationFiles();
      const cpu = process.cpuUsage();
      const started = performance.now();
      const manifest = await repository.capture(
        captureTree(source, {
          prefix: 'workspace',
          excludeRegenerable: true,
          onExcluded: () => undefined,
        }),
        {
          release: 'measurement',
          schema: 1,
          capturedAt: new Date().toISOString(),
        },
      );
      const elapsedMs = performance.now() - started;
      const used = process.cpuUsage(cpu);
      let newlyWrittenObjectBytes = 0;
      let retainedObjectBytes = 0;
      for (const name of await readdir(join(repository.root, 'objects'))) {
        const bytes = (await stat(join(repository.root, 'objects', name))).size;
        retainedObjectBytes += bytes;
        if (!before.has(name)) newlyWrittenObjectBytes += bytes;
      }
      let retainedDestinationBytes = 0;
      let newlyWrittenDestinationBytes = 0;
      for (const [path, current] of await destinationFiles()) {
        retainedDestinationBytes += current.bytes;
        if (previousDestination.get(path)?.hash !== current.hash)
          newlyWrittenDestinationBytes += current.bytes;
      }
      const hash = createHash('sha256');
      for await (const bytes of restoreFile(destination, manifest, manifest.files[0]!, recoveryKey))
        hash.update(bytes);
      expect(hash.digest('hex')).toBe(createHash('sha256').update(data).digest('hex'));
      measured.push({
        phase,
        newlyWrittenObjectBytes,
        retainedObjectBytes,
        newlyWrittenDestinationBytes,
        retainedDestinationBytes,
        elapsedMs,
        cpuMicros: used.user + used.system,
        maxRssKiB: process.resourceUsage().maxRSS,
      });
    }
    expect(measured[0]!.newlyWrittenObjectBytes).toBeGreaterThan(data.length);
    expect(measured[1]!.newlyWrittenObjectBytes).toBe(0);
    expect(measured[1]!.retainedObjectBytes).toBe(measured[0]!.retainedObjectBytes);
    expect(measured[2]!.newlyWrittenObjectBytes).toBeGreaterThan(0);
    expect(measured[2]!.newlyWrittenObjectBytes).toBeLessThan(
      measured[0]!.newlyWrittenObjectBytes / 2,
    );
    const report = {
      dataset: 'SHAKE256 backup-measurement-v1, 8 MiB, 32-byte overwrite',
      transport: 'local destination writes; no network transfer claim',
      measurements: measured,
    };
    if (process.env.VERITY_BACKUP_MEASUREMENT_REPORT)
      await writeFile(
        process.env.VERITY_BACKUP_MEASUREMENT_REPORT,
        JSON.stringify(report, null, 2) + '\n',
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
