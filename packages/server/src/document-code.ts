import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, lstat, rm, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DOCUMENT_SESSION_DIRECTORY } from './document-workspace.js';
import type { GitRunner } from './provisioner.js';

/** Connect Code by fetching the remote only. Documents are never Git input. */
export async function connectDocumentCode(input: {
  workspace: string;
  url: string;
  authorization: string;
  git: GitRunner;
}): Promise<{ empty: boolean }> {
  const { workspace, url, authorization, git } = input;
  await mkdir(workspace, { recursive: true });
  const existing = await lstat(join(workspace, '.git')).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
  const finishCheckout = async () => {
    const pending = join(workspace, '.git', 'verity-checkout-pending');
    if (
      !(await lstat(pending).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      ))
    )
      return;
    const missing = (await git(['-C', workspace, 'ls-files', '--deleted', '-z'])).stdout
      .split('\0')
      .filter(Boolean);
    // checkout-index refuses existing files, preserving concurrent local edits.
    for (const path of missing) await git(['-C', workspace, 'checkout-index', '--', path]);
    await unlink(pending);
  };
  if (existing) {
    const origin = (await git(['-C', workspace, 'remote', 'get-url', 'origin'])).stdout.trim();
    if (origin !== url && origin !== `${url}.git`)
      throw new Error('Code is already connected to a different repository');
    let hasHead = true;
    try {
      await git(['-C', workspace, 'rev-parse', '--verify', 'HEAD']);
    } catch {
      hasHead = false;
    }
    if (hasHead) await finishCheckout();
    return { empty: !hasHead };
  }
  const staging = join(workspace, `.verity-code-${randomUUID()}`);
  try {
    await git(['-c', `http.extraheader=${authorization}`, 'clone', '--no-checkout', url, staging]);
    let paths: string[];
    try {
      paths = (await git(['-C', staging, 'ls-tree', '-rz', '--name-only', 'HEAD'])).stdout
        .split('\0')
        .filter(Boolean);
    } catch {
      // An unborn HEAD is valid only for a genuinely empty clone.
      const refs = (
        await git(['-C', staging, 'for-each-ref', '--format=%(refname)'])
      ).stdout.trim();
      if (refs) throw new Error('Could not inspect the Code repository');
      paths = [];
    }
    for (const top of new Set(paths.map((path) => path.split('/')[0]!))) {
      if ([DOCUMENT_SESSION_DIRECTORY, '.verity-sessions'].includes(top))
        throw new Error('Code repository uses a reserved Verity directory');
      const occupied = await lstat(join(workspace, top)).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      );
      if (occupied) throw new Error(`Code would replace an existing project file: ${top}`);
    }
    const exclude = await open(
      join(staging, '.git', 'info', 'exclude'),
      constants.O_WRONLY | constants.O_APPEND,
    );
    try {
      await exclude.writeFile(`\n/${DOCUMENT_SESSION_DIRECTORY}/\n/.verity-sessions/\n`);
      await exclude.sync();
    } finally {
      await exclude.close();
    }
    await writeFile(join(staging, '.git', 'verity-document-code'), '1', { flag: 'wx' });
    if (paths.length) {
      await git(['-C', staging, 'reset', '--mixed', 'HEAD']);
      await writeFile(join(staging, '.git', 'verity-checkout-pending'), '1', { flag: 'wx' });
    }
    await rename(join(staging, '.git'), join(workspace, '.git'));
    if (paths.length) await finishCheckout();
    return {
      empty:
        paths.length === 0 && !(await readdir(join(workspace, '.git', 'refs', 'heads'))).length,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
