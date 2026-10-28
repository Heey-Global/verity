import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readlink, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { generateBackupKeys } from './crypto.js';
import { BackupRepository, type CaptureEntry } from './repository.js';
import { stageSnapshot } from './staging.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('private restore staging', () => {
  it('preserves empty directories and external symlinks without following them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-backup-stage-'));
    roots.push(root);
    const { host, recoveryKey } = await generateBackupKeys();
    const repository = new BackupRepository(
      join(root, 'backup'),
      join(root, 'host'),
      `${randomUUID()}-r1`,
      host,
    );
    await repository.initialize();
    const outside = join(root, 'outside');
    await mkdir(outside);
    async function* entries(): AsyncGenerator<CaptureEntry> {
      yield { kind: 'directory', path: 'empty', mode: 0o755 };
      yield { kind: 'symlink', path: 'external', target: outside };
      yield {
        path: 'project/data',
        mode: 0o600,
        source: (async function* () {
          yield Buffer.from('saved');
        })(),
      };
    }
    const manifest = await repository.capture(entries(), {
      release: 'v1.0.0',
      schema: 1,
      capturedAt: new Date().toISOString(),
    });
    const staged = await stageSnapshot(root, join(root, 'backup'), manifest, recoveryKey);
    expect(await readFile(join(staged, 'project/data'), 'utf8')).toBe('saved');
    expect(await readlink(join(staged, 'external'))).toBe(outside);
    expect(await readdir(join(staged, 'empty'))).toEqual([]);
    expect(await readdir(outside)).toEqual([]);
    manifest.files[0]!.path = 'external/escape';
    await expect(stageSnapshot(root, join(root, 'backup'), manifest, recoveryKey)).rejects.toThrow(
      'Conflicting',
    );
    expect(await readdir(outside)).toEqual([]);
  });
});
