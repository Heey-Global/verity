import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import {
  decryptStream,
  encryptStream,
  generateBackupKeys,
  openMetadata,
  sealMetadata,
} from './crypto.js';
import { BackupRepository, readSnapshot, restoreFile } from './repository.js';
import { InstallerRestoreStaging } from './restore-staging.js';
import type { RestoreJob } from './restore-job.js';
const extract = vi.hoisted(() => vi.fn());
vi.mock('./staging.js', () => ({ stageSnapshot: extract }));
function stream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}
it('rejects recipient-encrypted unsigned manifests and authenticated future formats before any restore effect, preserving the last good snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-authenticity-'));
  const { host, recoveryKey } = await generateBackupKeys();
  const repository = new BackupRepository(
    join(root, 'backup/repositories'),
    join(root, 'state'),
    randomUUID() + '-r1',
    host,
  );
  const effects = {
    checkRelease: vi.fn(),
    supportsRecovery: vi.fn(),
    withFreshDatabase: vi.fn(),
    stageHost: vi.fn(),
    stageData: vi.fn(),
  };
  try {
    await repository.initialize();
    const manifest = await repository.capture(
      (async function* () {
        yield {
          path: 'workspaces/file',
          mode: 0o600,
          source: (async function* () {
            yield Buffer.from('last good');
          })(),
        };
      })(),
      { release: 'v1', schema: 1, capturedAt: '2026-10-01T00:00:00Z' },
    );
    const goodPath = join(repository.root, 'snapshots', '1-manual');
    const original = await readFile(goodPath);
    const ciphertext = Buffer.from(
      await new Response(
        await encryptStream(
          host.recipient,
          stream(Buffer.from(JSON.stringify({ ...manifest, sequence: 2 }))),
        ),
      ).arrayBuffer(),
    );
    // The public recipient can create a fully decryptable age envelope without signing authority.
    expect(
      await new Response(await decryptStream(recoveryKey, stream(ciphertext))).text(),
    ).toContain('workspaces/file');
    const unsigned = Buffer.concat([Buffer.alloc(64), ciphertext]);
    await expect(openMetadata(recoveryKey, unsigned)).rejects.toThrow('signature');
    const foreign = await generateBackupKeys();
    const wrongSigner = await sealMetadata(
      { ...foreign.host, recipient: host.recipient },
      Buffer.from(JSON.stringify({ ...manifest, sequence: 2 })),
    );
    const future = await sealMetadata(
      host,
      Buffer.from(JSON.stringify({ ...manifest, sequence: 2, format: 999 })),
    );
    const job: RestoreJob = {
      format: 1,
      id: randomUUID(),
      installationId: randomUUID(),
      selection: {
        source: join(root, 'backup'),
        repository: repository.name,
        sequence: 2,
        kind: 'manual',
        newIdentity: false,
      },
      verified: null,
      phase: 'verifying',
      startedAt: 1,
      updatedAt: 1,
    };
    const staging = new InstallerRestoreStaging({
      root: join(root, 'restore'),
      liveRoot: join(root, 'live'),
      ...effects,
    });
    await mkdir(join(root, 'live'));
    await writeFile(join(root, 'live', 'sentinel'), 'unchanged');
    for (const [envelope, reason] of [
      [unsigned, 'signature'],
      [wrongSigner, 'signature'],
      [future, 'Invalid backup manifest'],
    ] as const) {
      await writeFile(join(repository.root, 'snapshots', '2-manual'), envelope);
      await expect(
        readSnapshot(join(root, 'backup/repositories'), repository.name, 2, recoveryKey),
      ).rejects.toThrow(reason);
      await expect(staging.verify(job, recoveryKey)).rejects.toThrow(reason);
      expect(extract).not.toHaveBeenCalled();
      for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
      expect(await readFile(goodPath)).toEqual(original);
      expect(await readdir(join(root, 'live'))).toEqual(['sentinel']);
      expect(await readFile(join(root, 'live', 'sentinel'), 'utf8')).toBe('unchanged');
      const good = await readSnapshot(
        join(root, 'backup/repositories'),
        repository.name,
        1,
        recoveryKey,
      );
      const chunks = [];
      for await (const chunk of restoreFile(
        join(root, 'backup/repositories'),
        good,
        good.files[0]!,
        recoveryKey,
      ))
        chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe('last good');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
