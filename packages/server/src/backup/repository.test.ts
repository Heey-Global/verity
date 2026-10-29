import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateBackupKeys, recoverHostKeys, sealMetadata } from './crypto.js';
import { parseManifest } from './format.js';
import { BackupRepository, readSnapshot, restoreFile, type CaptureFile } from './repository.js';
import { withRepositoryLock } from './repository-lock.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'verity-backup-test-'));
  roots.push(root);
  const keys = await generateBackupKeys();
  const name = `${randomUUID()}-r1`;
  const repository = new BackupRepository(
    join(root, 'backup'),
    join(root, 'host'),
    name,
    keys.host,
  );
  await repository.initialize();
  return { root, name, repository, ...keys };
}
async function* files(data: Buffer): AsyncGenerator<CaptureFile> {
  yield {
    path: 'workspace/file',
    mode: 0o644,
    source: (async function* () {
      yield data;
    })(),
  };
}
const info = { release: 'v1.0.0', schema: 1, capturedAt: '2026-10-25T01:00:00Z' };

describe('backup repository', () => {
  it('restores a complete snapshot with only destination and recovery key, and reuses ciphertext', async () => {
    const f = await fixture();
    const data = randomBytes(512 * 1024);
    const first = await f.repository.capture(files(data), info);
    const second = await f.repository.capture(files(data), info);
    expect(second.files[0]!.objects).toEqual(first.files[0]!.objects);
    expect((await readdir(join(f.repository.root, 'objects'))).length).toBe(
      first.files[0]!.objects.length,
    );
    await rm(join(f.root, 'host'), { recursive: true });
    const host = await recoverHostKeys(
      f.recoveryKey,
      await readFile(join(f.repository.root, 'keys')),
    );
    expect(host).toEqual(f.host);
    const snapshot = await readSnapshot(join(f.root, 'backup'), f.name, 2, f.recoveryKey);
    const chunks: Buffer[] = [];
    for await (const chunk of restoreFile(
      join(f.root, 'backup'),
      snapshot,
      snapshot.files[0]!,
      f.recoveryKey,
    ))
      chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(data)).toBe(true);
  });
  it('does not publish a failed run, never reuses a reserved sequence, and repairs corrupt cached objects', async () => {
    const f = await fixture();
    const data = Buffer.from('recoverable data');
    const first = await f.repository.capture(files(data), info);
    async function* interrupted(): AsyncGenerator<CaptureFile> {
      yield* files(Buffer.from('new data'));
      throw new Error('power loss');
    }
    await expect(f.repository.capture(interrupted(), info)).rejects.toThrow('power loss');
    expect(await readdir(join(f.repository.root, 'snapshots'))).toEqual(['1-manual']);
    await writeFile(join(f.repository.root, 'objects', first.files[0]!.objects[0]!.id), 'corrupt');
    const next = await f.repository.capture(files(data), info);
    expect(next.sequence).toBe(3);
    expect(next.files[0]!.objects[0]!.id).not.toBe(first.files[0]!.objects[0]!.id);
  });
  it('rejects authenticated path traversal, cross-repository replay and conflicting paths', async () => {
    const f = await fixture();
    const snapshot = await f.repository.capture(files(Buffer.from('safe')), info);
    snapshot.files[0]!.path = '../escape';
    await writeFile(
      join(f.repository.root, 'snapshots', '1-manual'),
      await sealMetadata(f.host, Buffer.from(JSON.stringify(snapshot))),
    );
    await expect(readSnapshot(join(f.root, 'backup'), f.name, 1, f.recoveryKey)).rejects.toThrow(
      'Unsafe',
    );
    expect(() =>
      parseManifest(Buffer.from(JSON.stringify(snapshot)), `${randomUUID()}-r1`, 1),
    ).toThrow();
    snapshot.files[0]!.path = 'parent';
    snapshot.files.push({ path: 'parent/child', mode: 0o644, objects: [] });
    expect(() => parseManifest(Buffer.from(JSON.stringify(snapshot)), f.name, 1)).toThrow(
      'Conflicting',
    );
  });
  it('rejects tampered or truncated objects before yielding plaintext', async () => {
    const f = await fixture();
    const snapshot = await f.repository.capture(files(Buffer.from('safe')), info);
    const file = snapshot.files[0]!;
    await writeFile(join(f.repository.root, 'objects', file.objects[0]!.id), 'tampered');
    let yielded = false;
    await expect(
      (async () => {
        for await (const chunk of restoreFile(
          join(f.root, 'backup'),
          snapshot,
          file,
          f.recoveryKey,
        ))
          yielded = chunk.length > 0;
      })(),
    ).rejects.toThrow();
    expect(yielded).toBe(false);
  });
  it('serializes writers with a kernel lock and releases it on failure', async () => {
    const f = await fixture();
    const path = join(f.repository.root, 'lock');
    await withRepositoryLock(path, async () => {
      await expect(withRepositoryLock(path, async () => undefined)).rejects.toThrow('locked');
    });
    await expect(
      withRepositoryLock(path, async () => {
        throw new Error('interrupted');
      }),
    ).rejects.toThrow('interrupted');
    await withRepositoryLock(path, async () => undefined);
  });
});
