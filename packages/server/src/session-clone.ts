import { execFile } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  redactAuthHeader,
  RepositoryHasNoCommitsError,
  type GitWorktreeOptions,
  type WorktreeProvisioner,
} from './worktree.js';

const exec = promisify(execFile);

function assertRealDirectory(path: string): void {
  if (!lstatSync(path).isDirectory() || realpathSync(path) !== resolve(path)) {
    throw new Error('Session clone path must be a real directory without symlink ancestors');
  }
}

/** Refuse legacy worktrees and shared Git storage before exposing a checkout. */
export async function assertIndependentSessionClone(path: string): Promise<void> {
  assertRealDirectory(path);
  const gitDir = join(path, '.git');
  assertRealDirectory(gitDir);
  const inspect = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Session Git metadata contains a symlink');
      if (entry.isDirectory()) inspect(target);
    }
  };
  inspect(gitDir);
  for (const marker of ['commondir', 'objects/info/alternates', 'objects/info/http-alternates']) {
    if (existsSync(join(gitDir, marker))) {
      throw new Error('Session clone references shared Git storage; migration is required');
    }
  }
  const { stdout } = await exec('git', ['-C', path, 'rev-parse', '--absolute-git-dir']);
  if (resolve(stdout.trim()) !== gitDir) throw new Error('Session clone has external Git metadata');
  const { stdout: worktree } = await exec('git', ['-C', path, 'rev-parse', '--show-toplevel']);
  if (resolve(worktree.trim()) !== resolve(path))
    throw new Error('Session clone has external worktree');
}

/** Scratch control-plane sessions still require a private, server-allocated directory. */
export async function assertIndependentSessionWorkspace(
  path: string,
  scratchRoot?: string,
): Promise<void> {
  if (scratchRoot !== undefined) {
    assertRealDirectory(path);
    try {
      lstatSync(join(path, '.git'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        assertRealDirectory(scratchRoot);
        if (dirname(resolve(path)) !== resolve(scratchRoot)) {
          throw new Error('Scratch session path escapes its allocation root', { cause: error });
        }
        return;
      }
      throw error;
    }
  }
  await assertIndependentSessionClone(path);
}

/** Each checkout owns its objects, refs, index, config and dependency installs. */
export function createSessionCloneProvisioner(opts: GitWorktreeOptions): WorktreeProvisioner {
  const root = resolve(opts.worktreeRoot);
  const git =
    opts.git ??
    (async (args: readonly string[]) => {
      await exec('git', [...args]);
    });
  const validateTarget = (target: string): void => {
    assertRealDirectory(root);
    if (dirname(resolve(target)) !== root) throw new Error('Invalid session clone cleanup path');
    if (existsSync(target)) assertRealDirectory(target);
  };
  return {
    async add(branch) {
      const name = branch.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
      if (!name) throw new Error('Branch has no usable session directory name');
      mkdirSync(root, { recursive: true });
      const target = join(root, name);
      validateTarget(target);
      // Reserve the name ourselves so a failed clone cannot delete a pre-existing session.
      mkdirSync(target);
      let header: string | undefined;
      try {
        const base = opts.baseBranch ?? 'HEAD';
        let origin: string | undefined;
        try {
          origin = (
            await exec('git', ['-C', opts.repoDir, 'remote', 'get-url', 'origin'])
          ).stdout.trim();
        } catch {
          /* Offline repositories have no origin. */
        }
        await git(['clone', '--no-local', '--no-checkout', '--', opts.repoDir, target]);
        if (origin) await git(['-C', target, 'remote', 'set-url', 'origin', origin]);
        else await git(['-C', target, 'remote', 'remove', 'origin']);
        let start: string;
        if (opts.refreshBase && origin) {
          header = await opts.fetchAuthHeader?.();
          const args = [
            '-C',
            target,
            ...(header ? ['-c', `http.extraheader=${header}`] : []),
            'fetch',
            'origin',
            base,
          ];
          let failure: unknown;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              await git(args);
              failure = undefined;
              break;
            } catch (error) {
              failure = error;
            }
          }
          if (failure !== undefined) {
            throw failure instanceof Error ? failure : new Error('Git fetch failed');
          }
          start = 'FETCH_HEAD';
        } else {
          try {
            await exec('git', ['-C', opts.repoDir, 'rev-parse', '--verify', 'HEAD']);
          } catch {
            throw new RepositoryHasNoCommitsError();
          }
          start = (
            await exec('git', ['-C', opts.repoDir, 'rev-parse', '--verify', `${base}^{commit}`])
          ).stdout.trim();
        }
        await git(['-C', target, 'checkout', '-b', branch, start]);
        // Keep the integration branch available for review diffs without touching the source ref.
        if (base !== 'HEAD' && base !== branch)
          await git(['-C', target, 'branch', '-f', base, 'HEAD']);
        await assertIndependentSessionClone(target);
        return target;
      } catch (error) {
        validateTarget(target);
        rmSync(target, { recursive: true, force: true });
        if (error instanceof RepositoryHasNoCommitsError) throw error;
        const redacted = redactAuthHeader(String(error), header);
        // The original cause can contain the fetch credential and must never escape.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(redacted, { cause: new Error(redacted) });
      }
    },
    async remove(target) {
      validateTarget(target);
      if (!existsSync(target)) return;
      await assertIndependentSessionClone(target);
      rmSync(target, { recursive: true });
    },
  };
}

/** Existing local clones gain a remote after linking, while custom remotes remain intact. */
export async function reconcileSessionOrigin(
  git: import('./branches.js').GitOutput,
  checkout: string,
  url: string,
): Promise<void> {
  try {
    await git(['-C', checkout, 'remote', 'get-url', 'origin']);
    return;
  } catch (error) {
    if ((error as { code?: unknown }).code !== 2) throw error;
  }
  await git(['-C', checkout, 'remote', 'add', 'origin', url]);
}
