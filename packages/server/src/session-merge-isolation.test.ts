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

it.each(['unchanged', 'checked-out base', 'divergent base', 'concurrent ref update'])(
  'preserves local merge housekeeping safety: %s',
  async (intervention) => {
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
    let preservedTip: string | undefined;
    if (intervention !== 'unchanged') {
      git(session, 'checkout', 'main');
      writeFileSync(join(session, 'intervening'), 'new work\n');
      git(session, 'add', '.');
      git(session, 'commit', '-m', 'intervening work');
      preservedTip = git(session, 'rev-parse', 'HEAD');
      if (intervention !== 'checked-out base') git(session, 'checkout', 'agent/change');
      if (intervention === 'concurrent ref update') {
        git(session, 'update-ref', 'refs/heads/main', git(base, 'rev-parse', 'HEAD~1'));
      }
    }
    const synchronizedGit: GitOutput = async (args) => {
      if (
        intervention === 'concurrent ref update' &&
        args[2] === 'update-ref' &&
        args[3] === 'refs/heads/main'
      ) {
        git(session, 'update-ref', 'refs/heads/main', preservedTip!);
      }
      return sessionGit(args);
    };
    const synchronize = syncLocalMergeBase({
      basePath: base,
      worktree: session,
      base: 'main',
      baseTip: merged.baseTip,
      centralGit,
      sessionGit: synchronizedGit,
    });
    if (intervention !== 'unchanged') {
      if (intervention === 'concurrent ref update') await expect(synchronize).rejects.toThrow();
      else expect(await synchronize).toBe(false);
      expect(git(session, 'rev-parse', 'refs/heads/main')).toBe(preservedTip);
      expect(git(session, 'show', 'main:intervening')).toBe('new work');
      expect(git(session, 'symbolic-ref', '--short', 'HEAD')).toBe(
        intervention === 'checked-out base' ? 'main' : 'agent/change',
      );
      return;
    }
    expect(await synchronize).toBe(true);
    const reset = await branches.resetToLocalBase(session, 'main', merged, { git: sessionGit });

    expect(reset.deletedBranch).toBe('agent/change');
    expect(git(session, 'rev-parse', 'HEAD')).toBe(merged.baseTip);
    await branches.switch(session, { newBranch: 'agent/next' });
    expect(git(session, 'rev-parse', 'HEAD')).toBe(merged.baseTip);
    expect(git(session, 'show', 'HEAD:change')).toBe('session');
    expect(git(base, 'for-each-ref', '--format=%(refname)', 'refs/verity')).toBe('');
    expect(git(session, 'for-each-ref', '--format=%(refname)', 'refs/verity')).toBe('');
  },
);
