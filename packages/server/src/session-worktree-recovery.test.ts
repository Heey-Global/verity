import { chmod, lstat, mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';

import { repairSessionWorktreePermissions } from './session-worktree-recovery.js';

describe('repairSessionWorktreePermissions', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) {
      await chmod(root, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('repairs only the three Verity-owned traversal directories', async () => {
    root = await mkdtemp(join(tmpdir(), 'verity-worktree-recovery-'));
    const sessions = join(root, '.verity-sessions');
    const worktree = join(sessions, 'agent-safe');
    const nested = join(worktree, 'nested');
    await mkdir(nested, { recursive: true });
    await chmod(nested, 0o600);
    await chmod(worktree, 0o000);
    await chmod(sessions, 0o2000);
    await chmod(root, 0o000);

    await expect(
      repairSessionWorktreePermissions(worktree, process.getuid?.(), tmpdir()),
    ).resolves.toEqual({
      repaired: ['project-root', 'sessions-root', 'worktree'],
    });
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(sessions)).mode & 0o7777).toBe(0o2700);
    expect((await lstat(worktree)).mode & 0o777).toBe(0o700);
    expect((await lstat(nested)).mode & 0o777).toBe(0o600);
  });

  it('rejects nested targets and symlinked boundary components', async () => {
    root = await mkdtemp(join(tmpdir(), 'verity-worktree-recovery-'));
    const sessions = join(root, '.verity-sessions');
    const real = join(root, 'real');
    await mkdir(real);
    await symlink(real, sessions);
    await chmod(root, 0o600);

    await expect(
      repairSessionWorktreePermissions(join(sessions, 'agent-safe'), process.getuid?.(), tmpdir()),
    ).rejects.toThrow('sessions-root is not a real directory');
    expect((await lstat(root)).mode & 0o777).toBe(0o600);
    await expect(
      repairSessionWorktreePermissions(
        join(root, '.verity-sessions', 'agent-safe', 'nested'),
        process.getuid?.(),
        tmpdir(),
      ),
    ).rejects.toThrow('direct child');
  });

  it('refuses an unexpected owner instead of chowning it', async () => {
    root = await mkdtemp(join(tmpdir(), 'verity-worktree-recovery-'));
    const worktree = join(root, '.verity-sessions', 'agent-safe');
    await mkdir(worktree, { recursive: true });
    const uid = (await lstat(root)).uid;
    await expect(repairSessionWorktreePermissions(worktree, uid + 1, tmpdir())).rejects.toThrow(
      'not owned by the Verity server uid',
    );
  });

  it('refuses a correctly shaped worktree outside the configured clone root', async () => {
    root = await mkdtemp(join(tmpdir(), 'verity-worktree-recovery-'));
    const worktree = join(root, '.verity-sessions', 'agent-safe');
    await mkdir(worktree, { recursive: true });
    await expect(
      repairSessionWorktreePermissions(worktree, process.getuid?.(), join(tmpdir(), 'elsewhere')),
    ).rejects.toThrow('outside the configured clone root');
  });
});
