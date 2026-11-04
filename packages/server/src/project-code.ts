import { readdir } from 'node:fs/promises';
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
