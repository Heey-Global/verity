import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readBackupHostPlan, safeHostPath } from './host-plan.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function state() {
  const root = await mkdtemp(join(tmpdir(), 'backup-plan-'));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}
it('discovers defaults without creating installer state and preserves a custom destination', async () => {
  const root = await state();
  expect(await readBackupHostPlan(root, undefined, process.getuid!())).toMatchObject({
    backupPath: '/var/lib/verity/backups',
    provisioned: false,
  });
  await writeFile(join(root, 'backup-dir'), '/srv/archives\n');
  await writeFile(join(root, 'backup-provisioning-version'), '1\n');
  expect(await readBackupHostPlan(root, undefined, process.getuid!())).toMatchObject({
    backupPath: '/srv/archives',
    provisioned: true,
  });
});
it('rejects symlinked or writable installer state', async () => {
  const root = await state();
  await symlink('/etc/passwd', join(root, 'backup-dir'));
  await expect(readBackupHostPlan(root, undefined, process.getuid!())).rejects.toThrow();
  await rm(join(root, 'backup-dir'));
  await chmod(root, 0o777);
  await expect(readBackupHostPlan(root, undefined, process.getuid!())).rejects.toThrow('protected');
});
it('rejects destinations overlapping authority and fixed host system paths', async () => {
  const root = await state();
  for (const path of [
    root,
    `${root}/child`,
    '/var/lib/verity',
    '/etc/backups',
    '/run/backup',
    '/srv/../backups',
    '/',
  ]) {
    await writeFile(join(root, 'backup-dir'), path);
    await expect(readBackupHostPlan(root, undefined, process.getuid!()), path).rejects.toThrow(
      'Unsafe',
    );
  }
});
it('rejects shell metacharacters and unnormalized host paths', () => {
  for (const path of ['/tmp/a:ro', '/tmp/a\n', '/tmp/a/../b', '/tmp//b', '/tmp/$(id)', '/'])
    expect(safeHostPath(path)).toBe(false);
});
