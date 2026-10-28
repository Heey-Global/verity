import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { restoreComposeDatabaseVolume } from './restore-compose-volume.js';

it('uses the database volume selected by the actual bundled Compose project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-compose-volume-'));
  const job = { id: randomUUID() };
  const host = join(root, job.id, 'host');
  await mkdir(host, { recursive: true });
  const compose = parse(readFileSync('deploy/docker-compose.yml', 'utf8')) as {
    services: { postgres: { volumes: string[] } };
    volumes: Record<string, { name?: string } | null>;
  };
  const source = compose.services.postgres.volumes
    .find((mount) => mount.endsWith(':/var/lib/postgresql'))!
    .split(':')[0]!;
  try {
    for (const project of ['verity', 'recovered-custom_2']) {
      await writeFile(join(host, 'compose-project'), project);
      const expected = compose.volumes[source]?.name ?? `${project}_${source}`;
      expect(await restoreComposeDatabaseVolume(root, job)).toBe(expected);
    }
    for (const invalid of ['', '../other', 'Uppercase', 'a/b']) {
      await writeFile(join(host, 'compose-project'), invalid);
      await expect(restoreComposeDatabaseVolume(root, job)).rejects.toThrow('Compose project');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
