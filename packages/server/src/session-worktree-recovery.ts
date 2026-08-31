import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, open } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

const SESSION_ROOT_SEGMENT = `${sep}.verity-sessions${sep}`;
// Linux O_PATH is intentionally not exposed by Node's fs.constants. It opens a metadata-only
// inode handle without requiring read permission, which is exactly what permission recovery
// needs for mode 000 directories. Verity server deployments are Linux containers.
const LINUX_O_PATH = 0o10000000;

export interface SessionWorktreeRecoveryResult {
  repaired: Array<'project-root' | 'sessions-root' | 'worktree'>;
}

/**
 * Restore only the owner bits required to traverse and use one Verity-created
 * session worktree. This deliberately does not recurse: repository contents are
 * agent-owned data, while these three directory inodes are the spawn boundary.
 *
 * Every component is checked without following symlinks and must still be owned
 * by the Server uid. An ownership change therefore fails closed instead of
 * turning this endpoint into a privileged chown primitive.
 */
export async function repairSessionWorktreePermissions(
  worktree: string,
  expectedUid = process.getuid?.(),
  projectCloneRoot?: string,
): Promise<SessionWorktreeRecoveryResult> {
  if (expectedUid === undefined) throw new Error('numeric server uid is unavailable');
  if (process.platform !== 'linux') throw new Error('safe worktree recovery requires Linux O_PATH');
  const normalized = resolve(worktree);
  const marker = normalized.lastIndexOf(SESSION_ROOT_SEGMENT);
  if (marker <= 0) throw new Error('session worktree is outside a Verity sessions root');

  const projectRoot = normalized.slice(0, marker);
  const sessionsRoot = normalized.slice(0, marker + SESSION_ROOT_SEGMENT.length - 1);
  if (projectCloneRoot === undefined || dirname(projectRoot) !== resolve(projectCloneRoot)) {
    throw new Error('session worktree project is outside the configured clone root');
  }
  if (dirname(normalized) !== sessionsRoot) {
    throw new Error('session worktree must be a direct child of the Verity sessions root');
  }

  const targets = [
    ['project-root', projectRoot],
    ['sessions-root', sessionsRoot],
    ['worktree', normalized],
  ] as const;
  const repaired: SessionWorktreeRecoveryResult['repaired'] = [];
  const validated: Array<{
    kind: (typeof targets)[number][0];
    handle: Awaited<ReturnType<typeof open>>;
    mode: number;
    desired: number;
  }> = [];
  try {
    // A missing owner execute bit prevents even lstat/open of the next child. Repair ancestors
    // transactionally as we descend, pinning each inode; any later refusal rolls all earlier
    // changes back before this function rejects.
    for (const [kind, path] of targets) {
      const before = await lstat(path);
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw new Error(`${kind} is not a real directory`);
      }
      if (before.uid !== expectedUid) {
        throw new Error(`${kind} is not owned by the Verity server uid`);
      }
      const handle = await open(
        path,
        LINUX_O_PATH | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
      const current = await handle.stat();
      if (!current.isDirectory() || current.dev !== before.dev || current.ino !== before.ino) {
        await handle.close();
        throw new Error(`${kind} changed during permission recovery`);
      }
      // Preserve setuid/setgid/sticky bits; recovery adds owner access and removes nothing.
      const mode = current.mode & 0o7777;
      const desired = mode | 0o700;
      validated.push({ kind, handle, mode, desired });
      if (desired !== mode) {
        await chmod(`/proc/self/fd/${String(handle.fd)}`, desired);
        repaired.push(kind);
      }
    }
  } catch (error) {
    // Best-effort rollback if validation or a filesystem error interrupts the three-inode repair.
    for (const target of validated.toReversed()) {
      if (repaired.includes(target.kind))
        await chmod(`/proc/self/fd/${String(target.handle.fd)}`, target.mode).catch(() => {});
    }
    throw error;
  } finally {
    await Promise.all(validated.map(async ({ handle }) => handle.close().catch(() => {})));
  }
  return { repaired };
}
