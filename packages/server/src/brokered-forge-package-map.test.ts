import { mkdtemp, mkdir, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadForgePackageMap } from './brokered-forge-package-map.js';
describe('server-owned package mapping', () => {
  it('defaults to no package grants and rejects unsafe mappings and links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-package-map-'));
    try {
      expect((await loadForgePackageMap(root)).size).toBe(0);
      const directory = join(root, 'forge-proxy');
      await mkdir(directory, { mode: 0o700 });
      const file = join(directory, 'packages.json');
      await writeFile(file, JSON.stringify({ project: ['acme/app/server'] }), { mode: 0o600 });
      expect((await loadForgePackageMap(root)).get('project')).toEqual(['acme/app/server']);
      await writeFile(file, JSON.stringify({ project: ['acme/app/../other'] }));
      await expect(loadForgePackageMap(root)).rejects.toThrow();
      await writeFile(file, JSON.stringify({ project: ['acme/app/server'] }));
      await chmod(file, 0o644);
      await expect(loadForgePackageMap(root)).rejects.toThrow('untrusted');
      await rm(file);
      await writeFile(join(root, 'outside'), '{}');
      await symlink(join(root, 'outside'), file);
      await expect(loadForgePackageMap(root)).rejects.toThrow('untrusted');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
