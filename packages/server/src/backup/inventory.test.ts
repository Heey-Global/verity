import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { expect, it, vi } from 'vitest';
import { readCaptureInventory, UNASSIGNED_BACKUP_SCOPE } from './inventory.js';

it('retains hidden, archived and orphan data with nonoverlapping ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-inventory-'));
  try {
    for (const path of [
      'workspaces/pinned',
      'workspaces/orphan',
      'sessions/shared',
      'sessions/owned',
    ])
      await mkdir(join(root, path), { recursive: true });
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM projects'))
        return {
          rows: [
            {
              id: 'p',
              owner: 'renamed',
              repo: 'repo',
              clone_dir: 'pinned',
              state: 'sleeping',
              archived: true,
            },
            {
              id: 'hidden',
              owner: 'test',
              repo: 'hidden',
              clone_dir: null,
              state: 'absent',
              archived: false,
            },
          ],
        };
      if (sql.includes('FROM sessions'))
        return {
          rows: [
            { project_id: 'p', worktree: join(root, 'workspaces/pinned/nested') },
            { project_id: 'p', worktree: join(root, 'sessions/owned/s') },
            { project_id: 'p', worktree: join(root, 'sessions/shared/a') },
            { project_id: null, worktree: join(root, 'sessions/shared/b') },
          ],
        };
      return { rows: [{ session_id: 'running' }] };
    });
    const result = await readCaptureInventory({ query } as unknown as PoolClient, root);
    expect(result.projects.find((p) => p.id === 'p')).toMatchObject({
      archived: true,
      state: 'sleeping',
      paths: ['workspaces/pinned', 'sessions/owned'],
    });
    expect(result.projects.find((p) => p.id === 'hidden')?.paths).toEqual([]);
    expect(result.projects.find((p) => p.id === UNASSIGNED_BACKUP_SCOPE)?.paths).toEqual([
      'workspaces/orphan',
      'sessions/shared',
    ]);
    expect(result.activeTurns).toEqual(['running']);
    expect(query.mock.calls.map(([sql]) => sql).every((sql) => !/WHERE/i.test(sql))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects a schema the pinned release cannot recreate before reading filesystem inventory', async () => {
  const query = vi.fn(async () => ({ rows: [{ name: 'future-schema' }] }));
  await expect(
    readCaptureInventory({ query } as unknown as PoolClient, '/backup-root', 'pinned-schema'),
  ).rejects.toThrow('cannot be recreated');
  expect(query).toHaveBeenCalledOnce();
});
