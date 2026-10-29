import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureTree } from './filesystem.js';
import { generateBackupKeys } from './crypto.js';
import { BackupRepository } from './repository.js';
import { stageSnapshot } from './staging.js';
import { BackupFileChangedError } from './capture-errors.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('fd-relative backup capture', () => {
  it('captures empty directories, regular files and symlinks without reading their targets; records dependency exclusions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-backup-tree-'));
    roots.push(root);
    const source = join(root, 'source');
    await mkdir(join(source, 'empty'), { recursive: true });
    await mkdir(join(source, 'node_modules'));
    await writeFile(join(source, 'node_modules', 'generated'), '12345');
    await writeFile(join(source, 'file'), 'keep');
    await symlink('/outside/private', join(source, 'link'));
    const { host, recoveryKey } = await generateBackupKeys();
    const repository = new BackupRepository(
      join(root, 'backup'),
      join(root, 'host'),
      `${randomUUID()}-r1`,
      host,
    );
    await repository.initialize();
    const excluded: [string, bigint][] = [];
    const manifest = await repository.capture(
      captureTree(source, {
        prefix: 'workspaces/project',
        excludeRegenerable: true,
        onExcluded: (path, bytes) => excluded.push([path, bytes]),
      }),
      { release: 'v1', schema: 1, capturedAt: new Date().toISOString() },
    );
    expect(excluded).toEqual([['workspaces/project/node_modules', 5n]]);
    const staging = await stageSnapshot(root, join(root, 'backup'), manifest, recoveryKey);
    expect(await readFile(join(staging, 'workspaces/project/file'), 'utf8')).toBe('keep');
    expect(await readlink(join(staging, 'workspaces/project/link'))).toBe('/outside/private');
  });
  it('retries changing sources twice and publishes the final explicitly unstable copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-backup-changing-'));
    roots.push(root);
    const { host } = await generateBackupKeys();
    const repository = new BackupRepository(
      join(root, 'backup'),
      join(root, 'host'),
      `${randomUUID()}-r1`,
      host,
    );
    await repository.initialize();
    const attempts: number[] = [];
    async function* entries() {
      yield {
        path: 'changing',
        mode: 0o600,
        unstable: () => true,
        source: async function* (attempt: number) {
          attempts.push(attempt);
          yield Buffer.from(String(attempt));
          if (attempt < 2) throw new BackupFileChangedError();
        },
      };
    }
    const manifest = await repository.capture(entries(), {
      release: 'v1',
      schema: 1,
      capturedAt: new Date().toISOString(),
    });
    expect(attempts).toEqual([0, 1, 2]);
    expect(manifest.files[0]!.unstable).toBe(true);
    expect(manifest.files[0]!.objects).toHaveLength(1);
  });
});
