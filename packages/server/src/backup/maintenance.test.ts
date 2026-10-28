import { decodeLocalIndex } from './local-state.js';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  utimes,
  rename,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { generateBackupKeys } from './crypto.js';
import { BackupRepository } from './repository.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'verity-backup-gc-'));
  roots.push(root);
  const { host } = await generateBackupKeys();
  const installationId = randomUUID();
  const repository = new BackupRepository(
    join(root, 'backup'),
    join(root, 'state'),
    `${installationId}-r1`,
    host,
  );
  await repository.initialize();
  return { root, repository, installationId, host };
}
async function capture(repository: BackupRepository, value: string, time = '2026-01-01T00:00:00Z') {
  return repository.capture(
    (async function* () {
      yield {
        path: 'file',
        mode: 0o600,
        source: (async function* () {
          yield Buffer.from(value);
        })(),
      };
    })(),
    { release: 'v1', schema: 1, capturedAt: time },
  );
}
describe('fail-closed backup retention and garbage collection', () => {
  it('preserves newest and shared objects; prunes old snapshots before collecting unreferenced objects after grace', async () => {
    const f = await fixture();
    const first = await capture(f.repository, 'shared');
    const second = await capture(f.repository, 'discarded');
    const last = await capture(f.repository, 'shared');
    const now = Date.parse('2026-10-25T00:00:00Z');
    for (const id of await readdir(join(f.repository.root, 'objects')))
      await utimes(
        join(f.repository.root, 'objects', id),
        new Date(now - 2 * 86400000),
        new Date(now - 2 * 86400000),
      );
    const young = 'f'.repeat(64);
    await writeFile(join(f.repository.root, 'objects', young), 'interrupted publication');
    await utimes(join(f.repository.root, 'objects', young), new Date(now), new Date(now));
    expect(
      await f.repository.maintain({ installationId: f.installationId, now, paused: false }),
    ).toEqual({ snapshots: 2, objects: 1 });
    const index = decodeLocalIndex(
      await readFile(join(f.repository.stateRoot, 'index')),
      f.host.fingerprintKey,
    );
    expect(Object.values(index as Record<string, { id: string }>).map((entry) => entry.id)).toEqual(
      [first.files[0]!.objects[0]!.id],
    );
    expect(await readdir(join(f.repository.root, 'snapshots'))).toEqual([
      `${last.sequence}-manual`,
    ]);
    expect(await readdir(join(f.repository.root, 'objects'))).toEqual(
      expect.arrayContaining([first.files[0]!.objects[0]!.id, young]),
    );
    await expect(
      readFile(join(f.repository.root, 'objects', second.files[0]!.objects[0]!.id)),
    ).rejects.toThrow();
    expect(
      await f.repository.maintain({
        installationId: f.installationId,
        now: now + 2 * 86400000,
        paused: false,
      }),
    ).toEqual({ snapshots: 0, objects: 1 });
  });
  it('refuses all pruning on missing/corrupt/mismatched references and honors pause and installation ownership', async () => {
    const f = await fixture();
    await capture(f.repository, 'first');
    await capture(f.repository, 'second');
    const now = Date.parse('2026-10-25T00:00:00Z');
    const record = join(f.repository.stateRoot, 'references', '1');
    const original = await readFile(record);
    await rm(record);
    await expect(
      f.repository.maintain({ installationId: f.installationId, now, paused: false }),
    ).rejects.toThrow();
    expect(await readdir(join(f.repository.root, 'snapshots'))).toHaveLength(2);
    await writeFile(record, await readFile(join(f.repository.stateRoot, 'references', '2')));
    await expect(
      f.repository.maintain({ installationId: f.installationId, now, paused: false }),
    ).rejects.toThrow('maintenance refused');
    await writeFile(record, original);
    await writeFile(
      join(f.repository.root, 'snapshots', '1-manual'),
      await readFile(join(f.repository.root, 'snapshots', '2-manual')),
    );
    await expect(
      f.repository.maintain({ installationId: f.installationId, now, paused: false }),
    ).rejects.toThrow('maintenance refused');
    expect(
      await f.repository.maintain({ installationId: f.installationId, now, paused: true }),
    ).toEqual({ snapshots: 0, objects: 0 });
    await expect(
      f.repository.maintain({ installationId: randomUUID(), now, paused: false }),
    ).rejects.toThrow('another installation');
    expect(await readdir(join(f.repository.root, 'snapshots'))).toHaveLength(2);
  });
});

it('refuses a substituted repository symlink before maintenance can touch another path', async () => {
  const f = await fixture();
  const original = f.repository.root;
  await rename(original, original + '-moved');
  await symlink(original + '-moved', original);
  await expect(
    f.repository.maintain({ installationId: f.installationId, now: Date.now(), paused: false }),
  ).rejects.toThrow();
  expect(await readdir(original + '-moved')).toContain('header');
});

it('keeps a snapshot published after the installation retention catalog was read', async () => {
  const f = await fixture();
  await capture(f.repository, 'published after catalog');
  const before = await readdir(join(f.repository.root, 'snapshots'));
  await f.repository.maintain({
    installationId: f.installationId,
    now: Date.now(),
    paused: false,
    retained: new Set(),
    catalogued: new Set(),
  });
  expect(await readdir(join(f.repository.root, 'snapshots'))).toEqual(before);
});
