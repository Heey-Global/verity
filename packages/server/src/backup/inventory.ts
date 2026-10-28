import { readdir } from 'node:fs/promises';
import { posix } from 'node:path';
import type { PoolClient } from 'pg';
import type { CaptureInventory } from './capture.js';
import { validateBackupPath } from './format.js';

export const UNASSIGNED_BACKUP_SCOPE = 'backup:unassigned';

/** Read all registry rows through the capture transaction, including hidden projects.
 * Filesystem entries without an unambiguous live owner remain part of the backup. */
export async function readCaptureInventory(
  client: PoolClient,
  root: string,
  expectedSchema?: string,
): Promise<CaptureInventory> {
  if (root !== posix.normalize(root) || !root.startsWith('/'))
    throw new Error('Invalid capture root');
  if (expectedSchema !== undefined) {
    const migration = await client.query<{ name: string }>(
      'SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 1',
    );
    if (migration.rows[0]?.name !== expectedSchema)
      throw new Error('Backup schema cannot be recreated by the pinned server image');
  }
  const projects = await client.query<{
    id: string;
    owner: string;
    repo: string;
    clone_dir: string | null;
    state: CaptureInventory['projects'][number]['state'];
    archived: boolean;
  }>('SELECT id, owner, repo, clone_dir, state, archived FROM projects ORDER BY id');
  const sessions = await client.query<{ project_id: string | null; worktree: string }>(
    'SELECT project_id, worktree FROM sessions ORDER BY session_id',
  );
  const turns = await client.query<{ session_id: string }>(
    'SELECT session_id FROM running_turns ORDER BY session_id',
  );
  if (projects.rows.length >= 10000 || sessions.rows.length > 50000 || turns.rows.length > 50000)
    throw new Error('Backup inventory limit exceeded');
  const inventory = new Map(
    projects.rows.map((row) => [
      row.id,
      {
        id: row.id,
        state: row.state,
        archived: row.archived,
        paths: [] as string[],
        warnings: [] as string[],
      },
    ]),
  );
  if (inventory.has(UNASSIGNED_BACKUP_SCOPE)) throw new Error('Reserved backup scope collision');
  const claims = new Map<string, Set<string>>();
  const claim = (path: string, id: string): void => {
    validateBackupPath(path);
    const owners = claims.get(path) ?? new Set<string>();
    owners.add(id);
    claims.set(path, owners);
  };
  for (const row of projects.rows) {
    const name = row.clone_dir ?? `${row.owner}-${row.repo}`;
    if (name.includes('/') || name.includes('\\'))
      throw new Error('Invalid project clone directory');
    claim(`workspaces/${name}`, row.id);
  }
  for (const row of sessions.rows) {
    if (!posix.isAbsolute(row.worktree)) throw new Error('Invalid session worktree');
    const path = posix.relative(root, row.worktree);
    validateBackupPath(path);
    const [scope, name] = path.split('/');
    if (!name || (scope !== 'workspaces' && scope !== 'sessions'))
      throw new Error('Session worktree outside backup scopes');
    claim(
      `${scope}/${name}`,
      row.project_id && inventory.has(row.project_id) ? row.project_id : UNASSIGNED_BACKUP_SCOPE,
    );
  }
  const unassigned: CaptureInventory['projects'][number] = {
    id: UNASSIGNED_BACKUP_SCOPE,
    state: 'absent',
    archived: false,
    paths: [],
    warnings: ['Retained filesystem data has no unambiguous current project owner.'],
  };
  for (const scope of ['workspaces', 'sessions']) {
    let entries: string[];
    try {
      entries = await readdir(posix.join(root, scope));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (entries.length > 50000) throw new Error('Backup filesystem inventory limit exceeded');
    for (const name of entries.sort()) {
      const path = `${scope}/${name}`;
      validateBackupPath(path);
      const owners = claims.get(path);
      const id = owners?.size === 1 ? [...owners][0] : undefined;
      (id ? (inventory.get(id) ?? unassigned) : unassigned).paths.push(path);
    }
  }
  return {
    projects: [...inventory.values(), ...(unassigned.paths.length ? [unassigned] : [])],
    activeTurns: turns.rows.map((row) => row.session_id),
  };
}
