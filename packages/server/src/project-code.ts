import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Infrastructure and generated files do not make an empty local project a Code project. */
const infrastructure = new Set([
  '.git',
  '.verity-sessions',
  '.verity-document-sessions',
  '.verity-worktree.json',
  '.agents',
  '.claude',
  '.codex',
  'AGENTS.md',
  'CLAUDE.md',
  'node_modules',
  'dist',
  'coverage',
  '.cache',
  '.expo',
  '.next',
  '.venv',
  '__pycache__',
]);

/** Inspect without following links or reading file contents. */
export async function hasCodeContent(root: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  for (const entry of entries) {
    if (infrastructure.has(entry.name)) continue;
    if (entry.isDirectory()) {
      if (await hasCodeContent(join(root, entry.name))) return true;
    } else if (entry.isFile() || entry.isSymbolicLink()) return true;
  }
  return false;
}

/** Legacy document sessions retain their view and use an adjacent code worktree. */
export function legacySessionCodePath(worktree: string, sessionId: string): string | undefined {
  const parts = worktree.split('/');
  const index = parts.lastIndexOf('.verity-document-sessions');
  if (index < 0 || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return undefined;
  return join(parts.slice(0, index).join('/') || '/', '.verity-sessions', `code-${sessionId}`);
}

const execFileAsync = promisify(execFile);

/** Saved session history remains a Code workspace even while both directories are empty. */
export async function hasSavedCodeWorkspace(
  clone: string,
  sessionId: string,
  path: string,
): Promise<boolean> {
  const journal = join(
    clone,
    '.git',
    'verity-storage',
    `retired-${createHash('sha256').update(path).digest('hex')}.json`,
  );
  if (
    await lstat(journal).then(
      () => true,
      (error: unknown) => {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
          return false;
        throw error;
      },
    )
  )
    return true;
  for (const ref of [`refs/heads/code-${sessionId}`, `refs/remotes/origin/code-${sessionId}`]) {
    if (
      await execFileAsync('git', ['-C', clone, 'rev-parse', '--verify', ref]).then(
        () => true,
        () => false,
      )
    )
      return true;
  }
  return false;
}
