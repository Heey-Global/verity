import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createSessionCloneProvisioner } from './session-clone.js';
import { createGitBranchService, type GitOutput } from './branches.js';
import { transferSessionCommit } from './session-git-transfer.js';
import { syncLocalMergeBase } from './session-merge-routes.js';

let temp: string | undefined;
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
});
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const scopedGit =
  (root: string): GitOutput =>
  (args) =>
    Promise.resolve().then(() => {
      if (args[0] !== '-C' || args[1] !== root)
        throw new Error('Sandbox cannot access another checkout');
      return execFileSync('git', [...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    });

it('starts the next branch from the saved integration commit in an independent clone', async () => {
  temp = mkdtempSync(join(tmpdir(), 'verity-transfer-'));
  const base = join(temp, 'base');
  mkdirSync(base);
  git(base, 'init', '-b', 'main');
  git(base, 'config', 'user.name', 'Test');
  git(base, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(base, 'original'), 'base\n');
  git(base, 'add', '.');
  git(base, 'commit', '-m', 'initial');
  const session = await createSessionCloneProvisioner({
    repoDir: base,
    worktreeRoot: join(temp, 'sessions'),
    baseBranch: 'main',
  }).add('agent/change');
  git(session, 'config', 'user.name', 'Test');
  git(session, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(session, 'change'), 'session\n');
  git(session, 'add', '.');
  git(session, 'commit', '-m', 'change');
  const sessionTip = git(session, 'rev-parse', 'HEAD');
  const centralGit = scopedGit(base);
  const sessionGit = scopedGit(session);
  const branches = createGitBranchService({ git: sessionGit });
  const imported = await transferSessionCommit({
    source: session,
    destination: base,
    sourceGit: sessionGit,
    destinationGit: centralGit,
  });
  const merged = await branches.mergeIntoLocalBase(session, base, {
    git: centralGit,
    sessionGit,
    mergeRef: imported.ref,
  });
  await imported.cleanup();
  expect(merged.mergedTip).toBe(sessionTip);
  expect(git(base, 'branch', '--list', 'agent/change')).toBe('');
  expect(git(base, 'rev-parse', 'HEAD')).toBe(merged.baseTip);
  await syncLocalMergeBase({
    basePath: base,
    worktree: session,
    base: 'main',
    baseTip: merged.baseTip,
    centralGit,
    sessionGit,
  });
  const reset = await branches.resetToLocalBase(session, 'main', merged, { git: sessionGit });

  expect(reset.deletedBranch).toBe('agent/change');
  expect(git(session, 'rev-parse', 'HEAD')).toBe(merged.baseTip);
  await branches.switch(session, { newBranch: 'agent/next' });
  expect(git(session, 'rev-parse', 'HEAD')).toBe(merged.baseTip);
  expect(git(session, 'show', 'HEAD:change')).toBe('session');
  expect(git(base, 'for-each-ref', '--format=%(refname)', 'refs/verity')).toBe('');
  expect(git(session, 'for-each-ref', '--format=%(refname)', 'refs/verity')).toBe('');
});
