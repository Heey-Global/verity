import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BaseCheckoutStrandedError,
  BaseCheckoutUnavailableError,
  BranchExistsError,
  BranchInUseError,
  BranchNotFoundError,
  createGitBranchService,
  DirtyWorktreeError,
  InvalidBranchNameError,
  MergeConflictError,
  NothingToMergeError,
  type GitOutput,
} from './branches.js';
import { SandboxUnavailableError } from './sandbox-git.js';

/**
 * A fake {@link GitOutput} that dispatches on the git args to canned stdout and
 * records every call. `routes` maps a join-by-space prefix of the args to a
 * handler returning stdout (or throwing, to simulate a non-zero git exit). The
 * longest matching prefix wins, so specific routes override broad ones.
 */
function fakeGit(routes: Record<string, () => string>) {
  const calls: string[][] = [];
  const git: GitOutput = async (args) => {
    calls.push([...args]);
    const joined = args.join(' ');
    const commandArgs: string[] = [];
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg.startsWith('--work-tree=')) continue;
      if (arg === '-c') {
        index += 1;
        continue;
      }
      commandArgs.push(arg);
    }
    const routable = commandArgs.join(' ');
    const keys = Object.keys(routes)
      .filter((k) => joined.includes(k) || routable.includes(k))
      .sort((a, b) => b.length - a.length);
    const key = keys[0];
    const handler = key === undefined ? undefined : routes[key];
    if (
      handler === undefined &&
      (joined.includes('status --porcelain --untracked-files=no') ||
        routable.includes('status --porcelain --untracked-files=no'))
    ) {
      return '';
    }
    if (
      handler === undefined &&
      (/rev-parse refs\/heads\//u.test(joined) || /rev-parse refs\/heads\//u.test(routable))
    )
      return 'f'.repeat(40);
    if (
      handler === undefined &&
      (joined.includes('update-ref -d refs/heads/') ||
        routable.includes('update-ref -d refs/heads/'))
    )
      return '';
    if (handler === undefined) throw new Error(`fakeGit: no route for: ${joined}`);
    return handler();
  };
  return { git, calls };
}

/** The pins the local-merge path puts on every index-touching invocation in `repoPath`.
 *  A session can write each of the corresponding keys into the shared `.git/config` of
 *  its project clone, where they either name a program git runs server-side or move
 *  where it writes — so a call that forgets them is a regression, not a formatting
 *  detail. */
function pinArgs(repoPath: string): string[] {
  return [
    `--work-tree=${repoPath}`,
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'merge.verifySignatures=false',
    '-c',
    'submodule.recurse=false',
    '-c',
    'credential.helper=',
    '-c',
    'core.sshCommand=ssh -F /dev/null',
    '-c',
    'protocol.ext.allow=never',
  ];
}

/** {@link pinArgs} as they appear in a joined command line, for routing. */
function pins(repoPath: string): string {
  return pinArgs(repoPath).join(' ');
}

/** A route that simulates a non-zero git exit (rejected promise). */
function fails(message = 'git exited non-zero'): () => string {
  return () => {
    throw new Error(message);
  };
}

describe('createGitBranchService', () => {
  it('uses the session worktree for repo-wide commands when repoDir is omitted', async () => {
    const { git, calls } = fakeGit({
      'for-each-ref --format=%(refname:short) refs/heads': () => 'main\nfeat/one\n',
      'worktree list --porcelain': () =>
        'worktree /wt/project-session\nbranch refs/heads/feat/one\n',
      'rev-parse --abbrev-ref HEAD': () => 'feat/one\n',
    });
    const svc = createGitBranchService({ git });

    await expect(svc.switchable('/wt/project-session')).resolves.toEqual(['main']);
    expect(calls).toContainEqual([
      '-C',
      '/wt/project-session',
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads',
    ]);
    expect(calls).toContainEqual(['-C', '/wt/project-session', 'worktree', 'list', '--porcelain']);
  });

  describe('current', () => {
    it('returns the trimmed branch name', async () => {
      const { git, calls } = fakeGit({
        'rev-parse --abbrev-ref HEAD': () => 'feature/x\n',
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      expect(await svc.current('/wt')).toBe('feature/x');
      expect(calls[0]).toEqual(['-C', '/wt', 'rev-parse', '--abbrev-ref', 'HEAD']);
    });
  });

  describe('sessionBranches', () => {
    it('returns the worktree HEAD plus the other branches from its reflog, recency-first', async () => {
      // A multi-phase session: HEAD is agent/ad858d4e (no PR), but it also created
      // several security/audit branches (some carrying their own PR). The worktree's
      // HEAD reflog records each checkout; newest entry first.
      const { git, calls } = fakeGit({
        'rev-parse --abbrev-ref HEAD': () => 'agent/ad858d4e\n',
        'reflog show --format=%gs HEAD': () =>
          [
            'checkout: moving from security/audit-phase5 to agent/ad858d4e',
            'checkout: moving from security/audit-phase4 to security/audit-phase5',
            'checkout: moving from security/audit-phase2 to security/audit-phase4',
            'checkout: moving from main to security/audit-phase2',
            'commit (initial): scaffold',
          ].join('\n') + '\n',
        // Every audit branch is a real local branch; the base is excluded before this
        // is ever consulted.
        'show-ref --verify --quiet refs/heads/security/audit-phase': () => '',
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      expect(await svc.sessionBranches('/wt')).toEqual([
        'agent/ad858d4e',
        'security/audit-phase5',
        'security/audit-phase4',
        'security/audit-phase2',
      ]);
      // The base branch is never probed for existence — it's dropped up front.
      expect(calls.some((c) => c.join(' ').includes('refs/heads/main'))).toBe(false);
    });

    it('drops reflog tokens that are not real local branches (e.g. detached SHAs)', async () => {
      const { git } = fakeGit({
        'rev-parse --abbrev-ref HEAD': () => 'agent/x\n',
        'reflog show --format=%gs HEAD': () =>
          [
            'checkout: moving from feat/real to agent/x',
            'checkout: moving from 1a2b3c4 to feat/real', // a bare SHA (detached preview)
          ].join('\n') + '\n',
        'show-ref --verify --quiet refs/heads/feat/real': () => '',
        'show-ref --verify --quiet refs/heads/1a2b3c4': fails(), // not a local branch
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      expect(await svc.sessionBranches('/wt')).toEqual(['agent/x', 'feat/real']);
    });

    it('falls back to just the current branch when the reflog is unavailable', async () => {
      const { git } = fakeGit({
        'rev-parse --abbrev-ref HEAD': () => 'feat/solo\n',
        'reflog show --format=%gs HEAD': fails(),
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      expect(await svc.sessionBranches('/wt')).toEqual(['feat/solo']);
    });
  });

  describe('isDirty', () => {
    it('is true when status --porcelain is non-empty', async () => {
      const { git } = fakeGit({ 'status --porcelain': () => ' M src/a.ts\n' });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      expect(await svc.isDirty('/wt')).toBe(true);
    });

    it('is false when status --porcelain is empty', async () => {
      const { git, calls } = fakeGit({ 'status --porcelain': () => '\n' });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      expect(await svc.isDirty('/wt')).toBe(false);
      expect(calls[0]).toEqual(['-C', '/wt', 'status', '--porcelain']);
    });
  });

  describe('switchable', () => {
    it('drops branches checked out in any worktree, excludes current, puts main first', async () => {
      const { git, calls } = fakeGit({
        'rev-parse --abbrev-ref HEAD': () => 'feature/current\n',
        'for-each-ref': () => 'feature/a\nmain\nfeature/b\nfeature/current\n',
        'worktree list --porcelain': () =>
          [
            'worktree /wt',
            'HEAD abc',
            'branch refs/heads/feature/current',
            '',
            'worktree /other',
            'HEAD def',
            'branch refs/heads/feature/b',
            '',
          ].join('\n'),
      });
      const svc = createGitBranchService({ repoDir: '/repo', baseBranch: 'main', git });
      // feature/current (this worktree) and feature/b (other worktree) removed;
      // main floated to the front, the rest sorted.
      expect(await svc.switchable('/wt')).toEqual(['main', 'feature/a']);
      expect(calls.find((c) => c.includes('for-each-ref'))).toEqual([
        '-C',
        '/repo',
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/heads',
      ]);
    });

    it('omits main from the front when it is not a candidate', async () => {
      const { git } = fakeGit({
        'rev-parse --abbrev-ref HEAD': () => 'main\n',
        'for-each-ref': () => 'feature/a\nfeature/b\n',
        'worktree list --porcelain': () => 'worktree /wt\nbranch refs/heads/main\n',
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      expect(await svc.switchable('/wt')).toEqual(['feature/a', 'feature/b']);
    });
  });

  describe('switch — exactly-one-of guard', () => {
    const guardMsg = 'specify exactly one of newBranch/branch/preview';

    it('throws when none of newBranch/branch/preview is set', async () => {
      const { git } = fakeGit({});
      const svc = createGitBranchService({ repoDir: '/repo', git });
      await expect(svc.switch('/wt', {})).rejects.toThrow(guardMsg);
    });

    it('throws when more than one of newBranch/branch/preview is set', async () => {
      const { git } = fakeGit({});
      const svc = createGitBranchService({ repoDir: '/repo', git });
      await expect(svc.switch('/wt', { newBranch: 'a', branch: 'b' })).rejects.toThrow(guardMsg);
      await expect(svc.switch('/wt', { branch: 'b', preview: 'c' })).rejects.toThrow(guardMsg);
      await expect(svc.switch('/wt', { newBranch: 'a', preview: 'c' })).rejects.toThrow(guardMsg);
    });
  });

  describe('switch — newBranch', () => {
    it('rejects an unsafe name with InvalidBranchNameError (path traversal)', async () => {
      const { git } = fakeGit({ 'status --porcelain': () => '' });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      await expect(svc.switch('/wt', { newBranch: '../x' })).rejects.toBeInstanceOf(
        InvalidBranchNameError,
      );
    });

    it('rejects a name with whitespace with InvalidBranchNameError', async () => {
      const { git } = fakeGit({ 'status --porcelain': () => '' });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      await expect(svc.switch('/wt', { newBranch: 'a b' })).rejects.toBeInstanceOf(
        InvalidBranchNameError,
      );
    });

    it('throws BranchExistsError when show-ref finds the branch', async () => {
      const { git } = fakeGit({
        'status --porcelain': () => '',
        'show-ref --verify --quiet refs/heads/feature/new': () => '', // exit 0 = exists
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      await expect(svc.switch('/wt', { newBranch: 'feature/new' })).rejects.toBeInstanceOf(
        BranchExistsError,
      );
    });

    it('checks out a new branch off the base on success', async () => {
      const { git, calls } = fakeGit({
        'status --porcelain': () => '',
        'show-ref --verify --quiet refs/heads/feature/new': fails(), // absent
        'checkout -b feature/new main': () => '',
        'rev-parse --abbrev-ref HEAD': () => 'feature/new\n',
      });
      const svc = createGitBranchService({ repoDir: '/repo', baseBranch: 'main', git });
      expect(await svc.switch('/wt', { newBranch: 'feature/new' })).toBe('feature/new');
      const checkout = calls.find((c) => c.includes('-b'));
      expect(checkout).toEqual(['-C', '/wt', 'checkout', '-b', 'feature/new', 'main']);
    });
  });

  describe('switch — existing branch', () => {
    it('throws BranchNotFoundError when the branch is missing', async () => {
      const { git } = fakeGit({
        'status --porcelain': () => '',
        'show-ref --verify --quiet refs/heads/gone': fails(),
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      await expect(svc.switch('/wt', { branch: 'gone' })).rejects.toBeInstanceOf(
        BranchNotFoundError,
      );
    });

    it('throws BranchInUseError when checked out in another worktree', async () => {
      const { git } = fakeGit({
        'status --porcelain': () => '',
        'show-ref --verify --quiet refs/heads/busy': () => '',
        'worktree list --porcelain': () => 'worktree /other\nbranch refs/heads/busy\n',
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      await expect(svc.switch('/wt', { branch: 'busy' })).rejects.toBeInstanceOf(BranchInUseError);
    });

    it('checks out the existing branch on success', async () => {
      const { git, calls } = fakeGit({
        'status --porcelain': () => '',
        'show-ref --verify --quiet refs/heads/feature/done': () => '',
        'worktree list --porcelain': () => 'worktree /wt\nbranch refs/heads/feature/current\n',
        'checkout -- feature/done': () => '',
        'rev-parse --abbrev-ref HEAD': () => 'feature/done\n',
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      expect(await svc.switch('/wt', { branch: 'feature/done' })).toBe('feature/done');
      const checkout = calls.find((c) => c.at(-1) === 'feature/done' && c.includes('checkout'));
      expect(checkout).toEqual(['-C', '/wt', 'checkout', '--', 'feature/done']);
    });
  });

  describe('switch — dirty handling', () => {
    it('throws DirtyWorktreeError when dirty and onDirty defaults to block', async () => {
      const { git } = fakeGit({ 'status --porcelain': () => ' M a\n' });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      await expect(svc.switch('/wt', { newBranch: 'x' })).rejects.toBeInstanceOf(
        DirtyWorktreeError,
      );
    });

    it('stashes when onDirty is stash', async () => {
      const { git, calls } = fakeGit({
        'status --porcelain': () => ' M a\n',
        'stash push --include-untracked': () => '',
        'show-ref --verify --quiet refs/heads/x': fails(),
        'checkout -b x main': () => '',
        'rev-parse --abbrev-ref HEAD': () => 'x\n',
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      expect(await svc.switch('/wt', { newBranch: 'x', onDirty: 'stash' })).toBe('x');
      const stash = calls.find((c) => c.includes('stash'));
      expect(stash).toEqual(['-C', '/wt', 'stash', 'push', '--include-untracked']);
    });

    it('adds and commits a checkpoint when onDirty is commit', async () => {
      const { git, calls } = fakeGit({
        'status --porcelain': () => ' M a\n',
        'add -A': () => '',
        commit: () => '',
        'show-ref --verify --quiet refs/heads/x': fails(),
        'checkout -b x main': () => '',
        'rev-parse --abbrev-ref HEAD': () => 'x\n',
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      expect(await svc.switch('/wt', { newBranch: 'x', onDirty: 'commit' })).toBe('x');
      const add = calls.find((c) => c.includes('add'));
      const commit = calls.find((c) => c.includes('commit'));
      expect(add).toEqual(['-C', '/wt', 'add', '-A']);
      expect(commit).toEqual(['-C', '/wt', 'commit', '-m', 'wip: checkpoint before branch switch']);
    });
  });

  describe('current — detached HEAD (#122)', () => {
    it('resolves a detached preview HEAD to the matching origin branch name', async () => {
      const { git } = fakeGit({
        'rev-parse --abbrev-ref HEAD': () => 'HEAD\n',
        '--points-at HEAD --format=%(refname:short) refs/remotes/origin': () =>
          'origin/HEAD\norigin/feat/streaming\n',
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      expect(await svc.current('/wt')).toBe('feat/streaming'); // not git's bare "HEAD"
    });

    it('resolves to a local branch when there is no remote at all (local project)', async () => {
      const { git } = fakeGit({
        'rev-parse --abbrev-ref HEAD': () => 'HEAD\n',
        '--points-at HEAD --format=%(refname:short) refs/remotes/origin': () => '\n',
        '--points-at HEAD --format=%(refname:short) refs/heads': () => 'main\n',
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      // The post-local-merge detach sits on the base tip; label it with that base.
      expect(await svc.current('/wt')).toBe('main');
    });

    it('falls back to a short SHA when no branch at all points at the detached HEAD', async () => {
      const { git } = fakeGit({
        'rev-parse --abbrev-ref HEAD': () => 'HEAD\n',
        '--points-at HEAD --format=%(refname:short) refs/remotes/origin': () => '\n',
        '--points-at HEAD --format=%(refname:short) refs/heads': () => '\n',
        'rev-parse --short HEAD': () => 'deadbee\n',
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      expect(await svc.current('/wt')).toBe('deadbee');
    });
  });

  describe('previewable (#122)', () => {
    it('lists origin/* branches minus base, current, and origin/HEAD; strips the prefix', async () => {
      const { git } = fakeGit({
        'rev-parse --abbrev-ref HEAD': () => 'main\n', // current = main (attached)
        'for-each-ref --format=%(refname:short) refs/remotes/origin': () =>
          'origin/HEAD\norigin/main\norigin/feat/streaming\norigin/agent/foo-s2\n',
      });
      const svc = createGitBranchService({ repoDir: '/repo', baseBranch: 'main', git });
      expect(await svc.previewable('/wt')).toEqual(['agent/foo-s2', 'feat/streaming']);
    });
  });

  describe('switch — preview (#122)', () => {
    it('fetches origin/<preview> and checks it out DETACHED, resolving the branch name', async () => {
      const { git, calls } = fakeGit({
        'status --porcelain': () => '', // clean worktree
        'fetch origin +refs/heads/feat/streaming:refs/remotes/origin/feat/streaming': () => '',
        'checkout --detach refs/remotes/origin/feat/streaming': () => '',
        'rev-parse --abbrev-ref HEAD': () => 'HEAD\n', // detached after checkout
        '--points-at HEAD --format=%(refname:short) refs/remotes/origin': () =>
          'origin/feat/streaming\n',
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      expect(await svc.switch('/wt', { preview: 'feat/streaming' })).toBe('feat/streaming');
      // fetch then a DETACHED checkout of the remote ref — never a local-branch checkout.
      expect(
        calls.some(
          (c) =>
            c.join(' ') ===
            '-C /wt fetch origin +refs/heads/feat/streaming:refs/remotes/origin/feat/streaming',
        ),
      ).toBe(true);
      expect(
        calls.some(
          (c) => c.join(' ') === '-C /wt checkout --detach refs/remotes/origin/feat/streaming',
        ),
      ).toBe(true);
    });

    it('rejects an unsafe preview name with InvalidBranchNameError (no fetch)', async () => {
      const { git, calls } = fakeGit({ 'status --porcelain': () => '' });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      await expect(svc.switch('/wt', { preview: '../evil' })).rejects.toBeInstanceOf(
        InvalidBranchNameError,
      );
      expect(calls.some((c) => c.includes('fetch'))).toBe(false);
    });

    it('maps a failed fetch (no such remote branch) to BranchNotFoundError', async () => {
      const { git } = fakeGit({
        'status --porcelain': () => '',
        'fetch origin +refs/heads/nope:refs/remotes/origin/nope': fails(),
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      await expect(svc.switch('/wt', { preview: 'nope' })).rejects.toBeInstanceOf(
        BranchNotFoundError,
      );
    });

    it('honours onDirty (stash) before a preview checkout', async () => {
      const { git, calls } = fakeGit({
        'status --porcelain': () => ' M a\n', // dirty
        'stash push --include-untracked': () => '',
        'fetch origin +refs/heads/feat/streaming:refs/remotes/origin/feat/streaming': () => '',
        'checkout --detach refs/remotes/origin/feat/streaming': () => '',
        'rev-parse --abbrev-ref HEAD': () => 'HEAD\n',
        '--points-at HEAD --format=%(refname:short) refs/remotes/origin': () =>
          'origin/feat/streaming\n',
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      expect(await svc.switch('/wt', { preview: 'feat/streaming', onDirty: 'stash' })).toBe(
        'feat/streaming',
      );
      // stash ran BEFORE the fetch/checkout.
      const stashIdx = calls.findIndex((c) => c.includes('stash'));
      const fetchIdx = calls.findIndex((c) => c.includes('fetch'));
      expect(stashIdx).toBeGreaterThanOrEqual(0);
      expect(stashIdx).toBeLessThan(fetchIdx);
    });

    it('blocks a preview on a dirty worktree by default (DirtyWorktreeError, no fetch)', async () => {
      const { git, calls } = fakeGit({ 'status --porcelain': () => ' M a\n' });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      await expect(svc.switch('/wt', { preview: 'feat/streaming' })).rejects.toBeInstanceOf(
        DirtyWorktreeError,
      );
      expect(calls.some((c) => c.includes('fetch'))).toBe(false);
    });
  });

  describe('resetToMergedBase', () => {
    it('fetches the base, detaches onto origin/base, and deletes the merged local branch', async () => {
      const { git, calls } = fakeGit({
        'rev-parse --abbrev-ref HEAD': () => 'agent/6c7016b5\n',
        'fetch origin +refs/heads/main:refs/remotes/origin/main': () => '',
        'checkout --detach refs/remotes/origin/main': () => '',
        // branchExists(feature) — show-ref against the repo succeeds.
        'show-ref --verify --quiet refs/heads/agent/6c7016b5': () => '',
        'branch -D agent/6c7016b5': () => '',
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });

      expect(await svc.resetToMergedBase('/wt')).toEqual({
        base: 'main',
        deletedBranch: 'agent/6c7016b5',
      });
      // Never claims the `main` branch (detached) — so a parallel worktree on main
      // can't be blocked.
      const checkoutCall = calls.find((call) => call.includes('checkout'));
      expect(checkoutCall).toEqual(
        expect.arrayContaining([
          '-C',
          '/wt',
          'core.hooksPath=/dev/null',
          'credential.helper=',
          'core.sshCommand=ssh -F /dev/null',
          'protocol.ext.allow=never',
          'checkout',
          '--detach',
          'refs/remotes/origin/main',
        ]),
      );
      const fetchCall = calls.find((call) => call.includes('fetch'));
      expect(fetchCall).toEqual(
        expect.arrayContaining([
          'credential.helper=',
          'core.sshCommand=ssh -F /dev/null',
          'protocol.ext.allow=never',
          'fetch',
        ]),
      );
      expect(calls.some((call) => call.includes('update-ref') && call.includes('-d'))).toBe(true);
      // Fetch runs before the checkout so the detach lands on the merged tip.
      const fetchIdx = calls.findIndex((c) => c.includes('fetch'));
      const checkoutIdx = calls.findIndex((c) => c.includes('checkout'));
      expect(fetchIdx).toBeGreaterThanOrEqual(0);
      expect(fetchIdx).toBeLessThan(checkoutIdx);
    });

    it('respects a custom base branch', async () => {
      const { git, calls } = fakeGit({
        'rev-parse --abbrev-ref HEAD': () => 'feature/x\n',
        'fetch origin +refs/heads/develop:refs/remotes/origin/develop': () => '',
        'checkout --detach refs/remotes/origin/develop': () => '',
        'show-ref --verify --quiet refs/heads/feature/x': () => '',
        'branch -D feature/x': () => '',
      });
      const svc = createGitBranchService({ repoDir: '/repo', baseBranch: 'develop', git });
      expect(await svc.resetToMergedBase('/wt')).toEqual({
        base: 'develop',
        deletedBranch: 'feature/x',
      });
      expect(calls.find((call) => call.includes('checkout'))).toEqual(
        expect.arrayContaining([
          '-C',
          '/wt',
          'checkout',
          '--detach',
          'refs/remotes/origin/develop',
        ]),
      );
    });

    /** A stacked PR merges into another session's branch. Resetting to the project's
     *  base would land the worktree on a commit WITHOUT the work that was merged. */
    it('resets to the branch the pull request merged into', async () => {
      const { git, calls } = fakeGit({
        'rev-parse --abbrev-ref HEAD': () => 'feat/child\n',
        'fetch origin +refs/heads/feat/parent:refs/remotes/origin/feat/parent': () => '',
        'checkout --detach refs/remotes/origin/feat/parent': () => '',
        'show-ref --verify --quiet refs/heads/feat/child': () => '',
        'branch -D feat/child': () => '',
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });

      expect(await svc.resetToMergedBase('/wt', { base: 'feat/parent' })).toEqual({
        base: 'feat/parent',
        deletedBranch: 'feat/child',
      });
      expect(calls.find((call) => call.includes('fetch'))).toEqual(
        expect.arrayContaining([
          '-C',
          '/wt',
          'fetch',
          'origin',
          '+refs/heads/feat/parent:refs/remotes/origin/feat/parent',
        ]),
      );
      expect(calls.some((c) => c.includes('origin/main'))).toBe(false);
    });

    /** The worktree now sits on the merge target, and the project's base is never a
     *  session's own branch — neither is this call's to delete. */
    it('deletes neither the branch it merged into nor the project base', async () => {
      for (const on of ['feat/parent', 'main']) {
        const { git, calls } = fakeGit({
          'rev-parse --abbrev-ref HEAD': () => `${on}\n`,
          'fetch origin +refs/heads/feat/parent:refs/remotes/origin/feat/parent': () => '',
          'checkout --detach refs/remotes/origin/feat/parent': () => '',
        });
        const svc = createGitBranchService({ repoDir: '/repo', git });
        expect(await svc.resetToMergedBase('/wt', { base: 'feat/parent' })).toEqual({
          base: 'feat/parent',
        });
        expect(calls.some((c) => c.includes('branch') && c.includes('-D'))).toBe(false);
      }
    });

    /** The ref reaches argv. Falling back to the project base instead would perform
     *  exactly the reset this parameter exists to prevent, so it refuses outright. */
    it('refuses a merge target git could read as anything but a ref', async () => {
      for (const base of ['--upload-pack=x', 'feat/a..b', 'feat/ x', 'feat/x^', 'feat/.hidden']) {
        const { git, calls } = fakeGit({ 'rev-parse --abbrev-ref HEAD': () => 'feat/child\n' });
        const svc = createGitBranchService({ repoDir: '/repo', git });

        await expect(svc.resetToMergedBase('/wt', { base })).rejects.toBeInstanceOf(
          InvalidBranchNameError,
        );
        expect(calls).toEqual([]);
      }
    });

    /** GitHub accepts ref names Verity would never mint. Judging a merge target by the
     *  policy for newly created branches would fail the cleanup on a perfectly good
     *  branch — for an argument, only git's own grammar matters. */
    it('accepts a merge target outside its own branch-naming policy', async () => {
      // `+release` is the interesting one: passed as a bare `fetch origin +release`,
      // git would read the `+` as the refspec's force marker and fetch `release`.
      for (const base of ['release+next', '+release', 'feature/ümlaut']) {
        const { git, calls } = fakeGit({
          'rev-parse --abbrev-ref HEAD': () => 'feat/child\n',
          [`fetch origin +refs/heads/${base}:refs/remotes/origin/${base}`]: () => '',
          [`checkout --detach refs/remotes/origin/${base}`]: () => '',
          'show-ref --verify --quiet refs/heads/feat/child': () => '',
          'branch -D feat/child': () => '',
        });
        const svc = createGitBranchService({ repoDir: '/repo', git });

        expect(await svc.resetToMergedBase('/wt', { base })).toEqual({
          base,
          deletedBranch: 'feat/child',
        });
        expect(calls.find((call) => call.includes('fetch'))).toEqual(
          expect.arrayContaining([
            '-C',
            '/wt',
            'fetch',
            'origin',
            `+refs/heads/${base}:refs/remotes/origin/${base}`,
          ]),
        );
      }
    });

    it('skips the branch delete when the worktree is already on the base', async () => {
      const { git, calls } = fakeGit({
        'rev-parse --abbrev-ref HEAD': () => 'main\n',
        'fetch origin +refs/heads/main:refs/remotes/origin/main': () => '',
        'checkout --detach refs/remotes/origin/main': () => '',
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      expect(await svc.resetToMergedBase('/wt')).toEqual({ base: 'main' });
      expect(calls.some((c) => c.includes('branch') && c.includes('-D'))).toBe(false);
    });

    it('skips the branch delete when no local branch matches the HEAD (detached/preview)', async () => {
      const { git, calls } = fakeGit({
        'rev-parse --abbrev-ref HEAD': () => 'a1b2c3d\n', // a short SHA, not a branch
        'fetch origin +refs/heads/main:refs/remotes/origin/main': () => '',
        'checkout --detach refs/remotes/origin/main': () => '',
        // branchExists(feature) — show-ref finds no such local ref (non-zero exit).
        'show-ref --verify --quiet refs/heads/a1b2c3d': fails(),
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      expect(await svc.resetToMergedBase('/wt')).toEqual({ base: 'main' });
      expect(calls.some((c) => c.includes('branch') && c.includes('-D'))).toBe(false);
    });

    it('leaves a worktree untouched when tracked changes appear before reset', async () => {
      const { git, calls } = fakeGit({
        'rev-parse --abbrev-ref HEAD': () => 'feat/live\n',
        'show-ref --verify --quiet refs/heads/feat/live': () => '',
        'rev-parse refs/heads/feat/live': () => 'a'.repeat(40),
        'status --porcelain --untracked-files=no': () => ' M src/live.ts\n',
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      await expect(svc.resetToMergedBase('/wt')).resolves.toEqual({ base: 'main' });
      expect(calls.some((call) => call.includes('fetch'))).toBe(false);
      expect(calls.some((call) => call.includes('checkout'))).toBe(false);
    });

    it('does not report deletion when the merged branch moves during compare-delete', async () => {
      const original = 'a'.repeat(40);
      const { git } = fakeGit({
        'rev-parse --abbrev-ref HEAD': () => 'feat/live\n',
        'show-ref --verify --quiet refs/heads/feat/live': () => '',
        'rev-parse refs/heads/feat/live': () => original,
        'fetch origin +refs/heads/main:refs/remotes/origin/main': () => '',
        'checkout --detach refs/remotes/origin/main': () => '',
        'update-ref -d refs/heads/feat/live': fails(),
        'rev-parse --verify refs/heads/feat/live': () => 'b'.repeat(40),
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });
      await expect(svc.resetToMergedBase('/wt')).resolves.toEqual({ base: 'main' });
    });
  });

  /** The merge commit a merge produced, as git prints it: a full object name, which is
   *  the only shape the deferred cleanup will hand to `checkout`. */
  const BASE_TIP = 'ba5e'.padEnd(40, '0');
  /** What `mergeIntoLocalBase` hands to `resetToLocalBase`. */
  const MERGED = { branch: 'feat/x', mergedTip: 'merged00', baseTip: BASE_TIP };

  describe('mergeIntoLocalBase', () => {
    /** Routes for the happy path: a clean worktree on `feat/x`, a clean project
     *  clone attached to `main`, and a branch `main` does not contain yet. */
    const mergeableRoutes = (): Record<string, () => string> => ({
      '-C /clone symbolic-ref --quiet --short HEAD': () => 'main\n',
      '-C /wt symbolic-ref --quiet --short HEAD': () => 'feat/x\n',
      '-C /wt show-ref --verify --quiet refs/heads/feat/x': () => '',
      [`-C /wt ${pins('/wt')} status --porcelain --untracked-files=no`]: () => '',
      [`-C /clone ${pins('/clone')} status --porcelain --untracked-files=no`]: () => '',
      // Non-zero exit = "not an ancestor" = there is something to merge.
      'merge-base --is-ancestor feat/x main': fails(),
      '-C /clone rev-parse refs/heads/feat/x': () => 'merged00\n',
      '-C /clone rev-parse refs/heads/main': () => `${BASE_TIP}\n`,
      'merge --no-ff --no-edit -- feat/x': () => '',
    });

    it('merges the branch into the clone with a pinned identity', async () => {
      const { git, calls } = fakeGit(mergeableRoutes());
      const svc = createGitBranchService({ git });

      expect(await svc.mergeIntoLocalBase('/wt', '/clone', { git })).toEqual({
        base: 'main',
        branch: 'feat/x',
        // Handed to `resetToLocalBase` so it can tell whether the branch moved on.
        mergedTip: 'merged00',
        // ... and where the worktree is to land, read under the same lock as the merge.
        baseTip: BASE_TIP,
      });
      // The merge commit is authored with a pinned identity: this runs outside the
      // sandbox, where git has no configured user and would abort. The untrusted-repo
      // pins ride along — a sandbox can point `core.hooksPath`/`core.fsmonitor` at its
      // own program in the shared config, which git would then run server-side.
      const merge = calls.find((c) => c.includes('merge') && c.includes('--no-ff'));
      expect(merge).toEqual([
        '-C',
        '/clone',
        ...pinArgs('/clone'),
        '-c',
        'user.name=Verity',
        '-c',
        'user.email=verity@localhost',
        '-c',
        'commit.gpgsign=false',
        'merge',
        '--no-ff',
        '--no-edit',
        '--',
        'feat/x',
      ]);
      // The worktree is left alone — the destructive reset is `resetToLocalBase`, which
      // the caller defers until the session is idle.
      expect(calls.some((c) => c.includes('checkout'))).toBe(false);
      expect(calls.some((c) => c.includes('-D'))).toBe(false);
    });

    it('merges into whatever branch the clone actually has checked out', async () => {
      const { git } = fakeGit({
        ...mergeableRoutes(),
        '-C /clone symbolic-ref --quiet --short HEAD': () => 'trunk\n',
        'merge-base --is-ancestor feat/x trunk': fails(),
        '-C /clone rev-parse refs/heads/trunk': () => `${BASE_TIP}\n`,
      });
      const svc = createGitBranchService({ git });

      expect((await svc.mergeIntoLocalBase('/wt', '/clone', { git })).base).toBe('trunk');
    });

    // A dev checkout can configure BOTH a global `repoDir` and a project clone root.
    // The session's branch only exists in the project's repository, so resolving it
    // through `repoDir` would reject a valid branch (or accept an unrelated one that
    // happens to share the name).
    it('looks the branch up in the session worktree, not a globally configured repoDir', async () => {
      const { git, calls } = fakeGit({
        ...mergeableRoutes(),
        '-C /elsewhere show-ref --verify --quiet refs/heads/feat/x': fails(),
      });
      const svc = createGitBranchService({ git, repoDir: '/elsewhere' });

      await expect(svc.mergeIntoLocalBase('/wt', '/clone', { git })).resolves.toMatchObject({
        branch: 'feat/x',
      });
      expect(calls.some((c) => c.includes('/elsewhere'))).toBe(false);
    });

    // Two sessions of one project merging at once would collide on git's index lock,
    // and the loser's `merge --abort` could roll back the winner's merge.
    it('serializes concurrent merges into the same base checkout', async () => {
      let started = 0;
      let releaseFirst = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        releaseFirst = () => resolve();
      });
      const { git } = fakeGit(mergeableRoutes());
      const instrumented = async (args: readonly string[]): Promise<string> => {
        if (args.includes('--no-ff')) {
          started += 1;
          if (started === 1) await gate; // hold the first merge open
        }
        return git(args);
      };
      const svc = createGitBranchService({ git: instrumented });

      const first = svc.mergeIntoLocalBase('/wt', '/clone', { git: instrumented });
      const second = svc.mergeIntoLocalBase('/wt', '/clone', { git: instrumented });
      await new Promise((resolve) => setTimeout(resolve, 0));
      // The second caller is parked behind the first, which is still mid-merge.
      expect(started).toBe(1);
      releaseFirst();
      await Promise.all([first, second]);
      expect(started).toBe(2);
    });

    // A rejected merge must not poison the queue for the next caller on that base.
    it('runs the next queued merge after one rejects', async () => {
      let attempts = 0;
      const { git } = fakeGit(mergeableRoutes());
      const instrumented = async (args: readonly string[]): Promise<string> => {
        if (args.includes('--no-ff')) {
          attempts += 1;
          if (attempts === 1) throw new Error('conflict');
        }
        return git(args);
      };
      const conflicting: GitOutput = async (args) =>
        args.join(' ').includes('merge --abort')
          ? ''
          : args.includes('--unmerged')
            ? 'M 100644 sha 1\ta.txt\n' // a genuine conflict, not some other failure
            : instrumented(args);
      const svc = createGitBranchService({ git: conflicting });

      const first = svc.mergeIntoLocalBase('/wt', '/clone', { git: conflicting });
      const second = svc.mergeIntoLocalBase('/wt', '/clone', { git: conflicting });
      await expect(first).rejects.toBeInstanceOf(MergeConflictError);
      await expect(second).resolves.toMatchObject({ base: 'main' });
    });

    /** A failed merge that left conflicted paths and MERGE_HEAD in the base checkout. */
    const conflictedRoutes = (): Record<string, () => string> => ({
      ...mergeableRoutes(),
      'merge --no-ff --no-edit -- feat/x': fails(),
      '-C /clone ls-files --unmerged': () => 'M 100644 sha 1\ta.txt\n',
      '-C /clone rev-parse --verify --quiet MERGE_HEAD': () => 'mergehead\n',
      [`-C /clone ${pins('/clone')} merge --abort`]: () => '',
    });

    it('aborts and reports a conflict without touching the worktree', async () => {
      const { git, calls } = fakeGit(conflictedRoutes());
      const svc = createGitBranchService({ git });

      await expect(svc.mergeIntoLocalBase('/wt', '/clone', { git })).rejects.toBeInstanceOf(
        MergeConflictError,
      );
      // Pinned like the merge: the abort rewinds the working tree and index too.
      expect(calls).toContainEqual(['-C', '/clone', ...pinArgs('/clone'), 'merge', '--abort']);
      expect(calls.some((c) => c.includes('checkout'))).toBe(false);
      expect(calls.some((c) => c.includes('-D'))).toBe(false);
    });

    // A conflict is resolvable and retryable; a hook, a full disk, or a corrupt repo
    // is not. Reporting the latter as a conflict would send the operator hunting for
    // conflict markers that do not exist.
    it('surfaces a non-conflict merge failure as itself, not as a conflict', async () => {
      const { git, calls } = fakeGit({
        ...conflictedRoutes(),
        'merge --no-ff --no-edit -- feat/x': fails('pre-merge hook refused'),
        '-C /clone ls-files --unmerged': () => '', // nothing conflicted
        '-C /clone rev-parse --verify --quiet MERGE_HEAD': fails(), // no merge in progress
      });

      await expect(
        createGitBranchService({ git }).mergeIntoLocalBase('/wt', '/clone', { git }),
      ).rejects.toThrow('pre-merge hook refused');
      // Nothing to roll back, so it must not run (and mask the real failure with) an abort.
      expect(calls.some((c) => c.includes('--abort'))).toBe(false);
    });

    it('refuses to call a merge it could not roll back a conflict', async () => {
      const { git } = fakeGit({
        ...conflictedRoutes(),
        [`-C /clone ${pins('/clone')} merge --abort`]: fails(),
      });

      // The base checkout is stuck mid-merge — a "resolve and retry" answer would be
      // wrong, so it gets its own error the route can word as such.
      const err = await createGitBranchService({ git })
        .mergeIntoLocalBase('/wt', '/clone', { git })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BaseCheckoutStrandedError);
      expect(err).not.toBeInstanceOf(MergeConflictError);
    });

    // The probes below a failed merge decide whether the base gets rolled back. A
    // sandbox that goes away between them answers neither, and the answer it would
    // otherwise stand in for is the one that skips the abort — so the base may be left
    // mid-merge, which must not reach the operator as "resolve the conflicts and retry"
    // or as "the project is stopped, start it and merge again".
    it('reports a base it could no longer roll back, not the conflict it found', async () => {
      const { git } = fakeGit(conflictedRoutes());
      const vanishes: GitOutput = async (args) =>
        args.includes('MERGE_HEAD')
          ? Promise.reject(new SandboxUnavailableError('verity-acme--app'))
          : git(args);

      const err = await createGitBranchService({ git: vanishes })
        .mergeIntoLocalBase('/wt', '/clone', { git: vanishes })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BaseCheckoutStrandedError);
      expect(err).not.toBeInstanceOf(SandboxUnavailableError);
      expect((err as BaseCheckoutStrandedError).cause).toBeInstanceOf(SandboxUnavailableError);
    });

    // ... but a merge that never ran because docker could not exec it left the base
    // exactly as it was. That one IS "start the project and merge again".
    it('reports a merge that never ran as a stopped project', async () => {
      const { git } = fakeGit(mergeableRoutes());
      const stopped: GitOutput = async (args) =>
        args.includes('--no-ff')
          ? Promise.reject(new SandboxUnavailableError('verity-acme--app'))
          : git(args);

      await expect(
        createGitBranchService({ git: stopped, mergeInProgress: () => false }).mergeIntoLocalBase(
          '/wt',
          '/clone',
          { git: stopped },
        ),
      ).rejects.toBeInstanceOf(SandboxUnavailableError);
    });

    // The daemon answers "that container is not there" identically whether the merge
    // never started or ran, conflicted, and lost its sandbox a moment later. Only the
    // base clone tells them apart, and with the sandbox gone that is a file on the
    // server's own disk — no probe through the sandbox can answer it any more.
    it('reports a base left mid-merge by a sandbox that went away, not a stopped project', async () => {
      const { git } = fakeGit(mergeableRoutes());
      const stopped: GitOutput = async (args) =>
        args.includes('--no-ff')
          ? Promise.reject(new SandboxUnavailableError('verity-acme--app'))
          : git(args);

      const err = await createGitBranchService({ git: stopped, mergeInProgress: () => true })
        .mergeIntoLocalBase('/wt', '/clone', { git: stopped })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BaseCheckoutStrandedError);
      expect(err).not.toBeInstanceOf(SandboxUnavailableError);
      expect((err as BaseCheckoutStrandedError).cause).toBeInstanceOf(SandboxUnavailableError);
    });

    // Every command of this path runs in the project's sandbox, never on the server.
    // The service's own runner exists for the branch switcher, which has no sandbox to
    // reach; wiring the merge to it would put a repository the session controls back in
    // front of server-side git, which is the whole reason this argument exists.
    it('runs only through the injected sandbox runner, never the service’s own', async () => {
      const { git, calls } = fakeGit(mergeableRoutes());
      const svc = createGitBranchService({
        git: () => Promise.reject(new Error('server-side git must not run here')),
      });

      await expect(svc.mergeIntoLocalBase('/wt', '/clone', { git })).resolves.toMatchObject({
        base: 'main',
      });
      expect(calls.some((c) => c.includes('--no-ff'))).toBe(true);
    });

    // The repository's config can name a program git runs (`filter.<n>.clean`,
    // `merge.<n>.driver`, `diff.<n>.textconv`), and those keys carry an arbitrary name,
    // so they cannot be pinned away on argv. There is nothing to refuse any more: the
    // command runs in the sandbox, where such a program is the sandbox's own and is
    // already allowed to run. Reading the config at all would only add a round trip.
    it('does not inspect the repository config before merging', async () => {
      const { git, calls } = fakeGit(mergeableRoutes());

      await expect(
        createGitBranchService({ git }).mergeIntoLocalBase('/wt', '/clone', { git }),
      ).resolves.toMatchObject({ base: 'main' });
      expect(calls.some((c) => c.includes('config'))).toBe(false);
    });

    // A stopped project is not a repository fact. Every other rejection here is read as
    // one ("not an ancestor" → there is something to merge), so this has to travel out
    // intact or the operator is told about a conflict that does not exist.
    it('surfaces an unavailable sandbox instead of reading it as a merge outcome', async () => {
      const { git } = fakeGit(mergeableRoutes());
      const stopped: GitOutput = async (args) =>
        args.includes('--is-ancestor')
          ? Promise.reject(new SandboxUnavailableError('verity-acme--app'))
          : git(args);

      await expect(
        createGitBranchService({ git: stopped }).mergeIntoLocalBase('/wt', '/clone', {
          git: stopped,
        }),
      ).rejects.toBeInstanceOf(SandboxUnavailableError);
    });

    it('refuses a detached base checkout before doing anything', async () => {
      const { git, calls } = fakeGit({
        ...mergeableRoutes(),
        '-C /clone symbolic-ref --quiet --short HEAD': fails(),
      });
      const svc = createGitBranchService({ git });

      await expect(svc.mergeIntoLocalBase('/wt', '/clone', { git })).rejects.toBeInstanceOf(
        BaseCheckoutUnavailableError,
      );
      expect(calls.some((c) => c.includes('merge'))).toBe(false);
    });

    it('refuses when either checkout has uncommitted changes to tracked files', async () => {
      const dirtyWorktree = fakeGit({
        ...mergeableRoutes(),
        [`-C /wt ${pins('/wt')} status --porcelain --untracked-files=no`]: () => ' M app.ts\n',
      });
      await expect(
        createGitBranchService({ git: dirtyWorktree.git }).mergeIntoLocalBase('/wt', '/clone', {
          git: dirtyWorktree.git,
        }),
      ).rejects.toBeInstanceOf(DirtyWorktreeError);
      expect(dirtyWorktree.calls.some((c) => c.includes('merge'))).toBe(false);

      const dirtyBase = fakeGit({
        ...mergeableRoutes(),
        [`-C /clone ${pins('/clone')} status --porcelain --untracked-files=no`]: () =>
          ' M README.md\n',
      });
      await expect(
        createGitBranchService({ git: dirtyBase.git }).mergeIntoLocalBase('/wt', '/clone', {
          git: dirtyBase.git,
        }),
      ).rejects.toBeInstanceOf(BaseCheckoutUnavailableError);
      expect(dirtyBase.calls.some((c) => c.includes('merge'))).toBe(false);
    });

    it('ignores untracked files — the clone always carries its .verity-sessions dir', async () => {
      // Asking for untracked files would report `?? .verity-sessions/` in every project
      // clone that has ever run a session, blocking every merge — so the tracked-only
      // route is the one that must match. The broad route below is what a regression to
      // plain `status --porcelain` would hit, and it fails the merge.
      const routes = mergeableRoutes();
      delete routes[`-C /wt ${pins('/wt')} status --porcelain --untracked-files=no`];
      delete routes[`-C /clone ${pins('/clone')} status --porcelain --untracked-files=no`];
      const { git, calls } = fakeGit({
        ...routes,
        'status --porcelain': () => '?? .verity-sessions/\n',
        'status --porcelain --untracked-files=no': () => '',
      });
      const svc = createGitBranchService({ git });

      await expect(svc.mergeIntoLocalBase('/wt', '/clone', { git })).resolves.toMatchObject({
        base: 'main',
      });
      expect(calls).toContainEqual([
        '-C',
        '/clone',
        ...pinArgs('/clone'),
        'status',
        '--porcelain',
        '--untracked-files=no',
      ]);
    });

    it('refuses a branch the base already contains, and the base itself', async () => {
      const contained = fakeGit({
        ...mergeableRoutes(),
        'merge-base --is-ancestor feat/x main': () => '',
      });
      await expect(
        createGitBranchService({ git: contained.git }).mergeIntoLocalBase('/wt', '/clone', {
          git: contained.git,
        }),
      ).rejects.toBeInstanceOf(NothingToMergeError);
      expect(contained.calls.some((c) => c.includes('--no-ff'))).toBe(false);

      const onBase = fakeGit({
        ...mergeableRoutes(),
        '-C /wt symbolic-ref --quiet --short HEAD': () => 'main\n',
      });
      await expect(
        createGitBranchService({ git: onBase.git }).mergeIntoLocalBase('/wt', '/clone', {
          git: onBase.git,
        }),
      ).rejects.toBeInstanceOf(NothingToMergeError);
    });

    // A detached worktree owns no branch. `current` would still name one — the branch
    // that happens to point at the same commit, which the preview UI wants and a merge
    // must not have: merging on that label would also DELETE that branch in the cleanup.
    it('refuses a detached worktree even when a branch points at its HEAD', async () => {
      const { git, calls } = fakeGit({
        ...mergeableRoutes(),
        '-C /wt symbolic-ref --quiet --short HEAD': fails(), // detached: exit 1 under --quiet
        '-C /wt rev-parse --abbrev-ref HEAD': () => 'HEAD\n',
        '-C /wt for-each-ref --points-at HEAD --format=%(refname:short) refs/heads': () =>
          'feat/x\n',
      });
      const svc = createGitBranchService({ git });

      await expect(svc.mergeIntoLocalBase('/wt', '/clone', { git })).rejects.toBeInstanceOf(
        BranchNotFoundError,
      );
      expect(calls.some((c) => c.includes('--no-ff'))).toBe(false);
    });

    // Both ref names are read out of the repository the sandbox owns and end up in argv
    // of commands that run outside it. `git checkout` cannot end option parsing before a
    // ref at all, so an option-shaped name is refused rather than escaped.
    it('refuses an option-shaped ref on either side without running a command', async () => {
      for (const [label, routes] of [
        ['session branch', { '-C /wt symbolic-ref --quiet --short HEAD': () => '-x\n' }],
        ['base branch', { '-C /clone symbolic-ref --quiet --short HEAD': () => '--upload-pack\n' }],
      ] as const) {
        const { git, calls } = fakeGit({ ...mergeableRoutes(), ...routes });

        await expect(
          createGitBranchService({ git }).mergeIntoLocalBase('/wt', '/clone', { git }),
        ).rejects.toBeInstanceOf(InvalidBranchNameError);
        expect(
          calls.some((c) => c.includes('--no-ff')),
          label,
        ).toBe(false);
        expect(
          calls.some((c) => c.includes('status')),
          label,
        ).toBe(false);
      }
    });
  });

  describe('resetToLocalBase', () => {
    /** A worktree still exactly on the commit `mergeIntoLocalBase` absorbed. */
    const unchangedRoutes = (): Record<string, () => string> => ({
      '-C /wt symbolic-ref --quiet --short HEAD': () => 'feat/x\n',
      '-C /wt show-ref --verify --quiet refs/heads/feat/x': () => '',
      '-C /wt rev-parse refs/heads/feat/x': () => 'merged00\n',
      [`-C /wt ${pins('/wt')} status --porcelain --untracked-files=no`]: () => '',
      [`-C /wt ${pins('/wt')} checkout --detach ${BASE_TIP}`]: () => '',
      [`-C /wt ${pins('/wt')} update-ref -d refs/heads/feat/x merged00`]: () => '',
    });

    it('deletes no branch when the worktree is already detached', async () => {
      // `current` would name the branch pointing at HEAD and the compare-and-delete
      // would then drop it, even though this session never had it checked out.
      const { git, calls } = fakeGit({
        ...unchangedRoutes(),
        '-C /wt symbolic-ref --quiet --short HEAD': fails(),
        '-C /wt for-each-ref --points-at HEAD --format=%(refname:short) refs/heads': () =>
          'feat/x\n',
      });

      expect(
        await createGitBranchService({ git }).resetToLocalBase('/wt', 'main', MERGED, { git }),
      ).toEqual({ base: 'main' });
      expect(calls.some((c) => c.includes('update-ref'))).toBe(false);
    });

    it('changes nothing when either ref name is option-shaped', async () => {
      // Same exposure as the merge, but the merge has already landed here, so the
      // cleanup reports the refusal as "nothing was touched" instead of throwing.
      const optionShapedFeature = fakeGit({
        ...unchangedRoutes(),
        '-C /wt symbolic-ref --quiet --short HEAD': () => '-x\n',
      });
      expect(
        await createGitBranchService({ git: optionShapedFeature.git }).resetToLocalBase(
          '/wt',
          'main',
          MERGED,
          { git: optionShapedFeature.git },
        ),
      ).toEqual({ base: 'main', skipped: true });
      expect(optionShapedFeature.calls.some((c) => c.includes('checkout'))).toBe(false);

      const { git, calls } = fakeGit(unchangedRoutes());
      expect(
        await createGitBranchService({ git }).resetToLocalBase('/wt', '-x', MERGED, { git }),
      ).toEqual({ base: '-x', skipped: true });
      expect(calls.some((c) => c.includes('checkout'))).toBe(false);
    });

    it('detaches onto the merged base and deletes the branch, without fetching', async () => {
      const { git, calls } = fakeGit(unchangedRoutes());

      expect(
        await createGitBranchService({ git }).resetToLocalBase('/wt', 'main', MERGED, { git }),
      ).toEqual({ base: 'main', deletedBranch: 'feat/x' });
      // The worktree shares the clone's objects and refs, so `main` is already at the
      // merge commit here — a fetch would only fail on a repository without a remote.
      expect(calls.some((c) => c.includes('fetch'))).toBe(false);
      // Unforced, so git refuses rather than overwrites if work appeared meanwhile.
      expect(calls.some((c) => c.includes('checkout') && c.includes('-f'))).toBe(false);
      // Both mutating commands carry the untrusted-repo pins: `post-checkout` and
      // `reference-transaction` hooks — and the fsmonitor program — are sandbox-writable,
      // and this runs server-side.
      const mutating = calls.filter((c) => c.includes('checkout') || c.includes('update-ref'));
      expect(mutating).toHaveLength(2);
      for (const call of mutating) {
        for (const pin of pinArgs('/wt')) expect(call).toContain(pin);
      }
    });

    // The tip check below cannot stand in for this: `git checkout -b spike` leaves a
    // second branch on the same commit, and deleting THAT one — plus detaching off it —
    // is the destructive half of the cleanup applied to something never merged.
    it('changes nothing when the worktree moved to another branch on the merged commit', async () => {
      const { git, calls } = fakeGit({
        ...unchangedRoutes(),
        '-C /wt symbolic-ref --quiet --short HEAD': () => 'spike\n',
        '-C /wt show-ref --verify --quiet refs/heads/spike': () => '',
        '-C /wt rev-parse refs/heads/spike': () => 'merged00\n',
      });

      expect(
        await createGitBranchService({ git }).resetToLocalBase('/wt', 'main', MERGED, { git }),
      ).toEqual({ base: 'main', skipped: true });
      expect(calls.some((c) => c.includes('checkout') || c.includes('update-ref'))).toBe(false);
    });

    // The cleanup is deferred, so another session can merge into the same base in
    // between. Detaching onto `refs/heads/<base>` would then land this worktree on THAT
    // session's merge while the operator is told they are on their own merged commit.
    it('detaches onto the commit this merge produced, not the branch as it stands now', async () => {
      const { git, calls } = fakeGit({
        ...unchangedRoutes(),
        // A sibling advanced the base after the merge returned.
        '-C /wt rev-parse refs/heads/main': () => 'newer111\n',
      });

      expect(
        await createGitBranchService({ git }).resetToLocalBase('/wt', 'main', MERGED, { git }),
      ).toEqual({ base: 'main', deletedBranch: 'feat/x' });
      const checkout = calls.find((c) => c.includes('checkout'));
      expect(checkout).toContain(BASE_TIP);
      expect(checkout).not.toContain('refs/heads/main');
    });

    // The tip reaches argv as a ref inside a repository the sandbox writes. Only a full
    // object name is handed to `checkout`: a short one could resolve to a different
    // commit, and a name could be read as an option.
    it('changes nothing when the merged tip is not a full object name', async () => {
      for (const baseTip of ['refs/heads/main', 'ba5e', '-x', '']) {
        const { git, calls } = fakeGit(unchangedRoutes());
        expect(
          await createGitBranchService({ git }).resetToLocalBase(
            '/wt',
            'main',
            { ...MERGED, baseTip },
            { git },
          ),
        ).toEqual({ base: 'main', skipped: true });
        expect(calls.some((c) => c.includes('checkout') || c.includes('update-ref'))).toBe(false);
      }
    });

    it('deletes nothing when the worktree was already on the base', async () => {
      const { git, calls } = fakeGit({
        '-C /wt rev-parse --abbrev-ref HEAD': () => 'main\n',
        [`-C /wt ${pins('/wt')} status --porcelain --untracked-files=no`]: () => '',
        [`-C /wt ${pins('/wt')} checkout --detach ${BASE_TIP}`]: () => '',
      });

      expect(
        await createGitBranchService({ git }).resetToLocalBase('/wt', 'main', MERGED, { git }),
      ).toEqual({ base: 'main' });
      expect(calls.some((c) => c.includes('update-ref'))).toBe(false);
    });

    // The pre-checks read the worktree an instant before acting on it, so neither step
    // may depend on them: git has to be the one that refuses.
    it('leaves the worktree alone when the checkout refuses to overwrite new work', async () => {
      // Clean when the pre-check reads it, dirty by the time the checkout runs: the
      // race this cleanup is built around, and the only thing `skipped` may stand for.
      let reads = 0;
      const { git, calls } = fakeGit({
        ...unchangedRoutes(),
        [`-C /wt ${pins('/wt')} status --porcelain --untracked-files=no`]: () =>
          ++reads > 1 ? ' M app.ts\n' : '',
        [`-C /wt ${pins('/wt')} checkout --detach ${BASE_TIP}`]: fails(
          'would be overwritten by checkout',
        ),
      });

      expect(
        await createGitBranchService({ git }).resetToLocalBase('/wt', 'main', MERGED, { git }),
      ).toEqual({ base: 'main', skipped: true });
      expect(calls.some((c) => c.includes('update-ref'))).toBe(false);
    });

    // `skipped` is worded to the operator as "your worktree kept the branch because it
    // has moved on since". A checkout that failed with a clean tree did not establish
    // that, and neither did a sandbox that went away — the caller has to say the
    // cleanup did not complete instead of explaining it away.
    it('surfaces a checkout that failed for anything but new work', async () => {
      const broken = fakeGit({
        ...unchangedRoutes(),
        [`-C /wt ${pins('/wt')} checkout --detach ${BASE_TIP}`]: fails('index file corrupt'),
      });
      await expect(
        createGitBranchService({ git: broken.git }).resetToLocalBase('/wt', 'main', MERGED, {
          git: broken.git,
        }),
      ).rejects.toThrow('index file corrupt');
      expect(broken.calls.some((c) => c.includes('update-ref'))).toBe(false);

      const { git } = fakeGit(unchangedRoutes());
      const stopped: GitOutput = async (args) =>
        args.includes('checkout')
          ? Promise.reject(new SandboxUnavailableError('verity-acme--app'))
          : git(args);
      await expect(
        createGitBranchService({ git: stopped }).resetToLocalBase('/wt', 'main', MERGED, {
          git: stopped,
        }),
      ).rejects.toBeInstanceOf(SandboxUnavailableError);
    });

    // Same reason on the other half: "kept" is a fact about the ref, and a sandbox that
    // could not run the delete has not established it.
    it('surfaces an unavailable sandbox instead of reading it as a branch that moved', async () => {
      const { git } = fakeGit(unchangedRoutes());
      const stopped: GitOutput = async (args) =>
        args.includes('update-ref')
          ? Promise.reject(new SandboxUnavailableError('verity-acme--app'))
          : git(args);

      await expect(
        createGitBranchService({ git: stopped }).resetToLocalBase('/wt', 'main', MERGED, {
          git: stopped,
        }),
      ).rejects.toBeInstanceOf(SandboxUnavailableError);
    });

    it('keeps the branch when it moved between the check and the delete', async () => {
      // `update-ref -d <ref> <oldvalue>` is a compare-and-delete: a commit that landed
      // after the tip check makes it fail, and the branch (with that commit) survives.
      let reads = 0;
      const { git, calls } = fakeGit({
        ...unchangedRoutes(),
        // The commit arrives between the pre-check and the delete, which is what the
        // compare-and-delete is there to catch.
        '-C /wt rev-parse refs/heads/feat/x': () => (++reads > 1 ? 'newer111\n' : 'merged00\n'),
        [`-C /wt ${pins('/wt')} update-ref -d refs/heads/feat/x merged00`]: fails(),
      });

      // Reported as its own outcome, not as the clean success: the checkout DID land,
      // so this is half-done, and the caller has to say the branch was kept.
      expect(
        await createGitBranchService({ git }).resetToLocalBase('/wt', 'main', MERGED, { git }),
      ).toEqual({ base: 'main', retainedBranch: 'feat/x' });
      expect(calls).toContainEqual([
        '-C',
        '/wt',
        ...pinArgs('/wt'),
        'update-ref',
        '-d',
        'refs/heads/feat/x',
        'merged00',
      ]);
    });

    // "Kept" is a fact about the ref, and `update-ref` failing is not that fact: a lock
    // it could not take, a full disk or a corrupt repository fail the same way. Reading
    // those as the race would tell the operator the cleanup finished the half-done way
    // when it is actually broken.
    it('surfaces a delete that failed with the branch still on the merged commit', async () => {
      const { git } = fakeGit({
        ...unchangedRoutes(),
        [`-C /wt ${pins('/wt')} update-ref -d refs/heads/feat/x merged00`]:
          fails('cannot lock ref'),
      });

      await expect(
        createGitBranchService({ git }).resetToLocalBase('/wt', 'main', MERGED, { git }),
      ).rejects.toThrow('cannot lock ref');
    });

    it('changes nothing when the branch advanced past the merged commit', async () => {
      // A turn ran and committed between the merge and this deferred cleanup: those
      // commits are not in the base, so detaching + deleting would strand them.
      const { git, calls } = fakeGit({
        ...unchangedRoutes(),
        '-C /wt rev-parse refs/heads/feat/x': () => 'newer111\n',
      });

      expect(
        await createGitBranchService({ git }).resetToLocalBase('/wt', 'main', MERGED, { git }),
      ).toEqual({ base: 'main', skipped: true });
      expect(calls.some((c) => c.includes('checkout') || c.includes('update-ref'))).toBe(false);
    });

    // Same as the merge: the cleanup is the sandbox's own git, so a `symbolic-ref` that
    // fails because the container is gone must not be read as "already detached" — that
    // reading would report a finished cleanup that never ran.
    it('surfaces an unavailable sandbox instead of reading it as a detached worktree', async () => {
      const { git } = fakeGit(unchangedRoutes());
      const stopped: GitOutput = async (args) =>
        args.includes('symbolic-ref')
          ? Promise.reject(new SandboxUnavailableError('verity-acme--app'))
          : git(args);

      await expect(
        createGitBranchService({ git: stopped }).resetToLocalBase('/wt', 'main', MERGED, {
          git: stopped,
        }),
      ).rejects.toBeInstanceOf(SandboxUnavailableError);
    });

    it('changes nothing when the worktree picked up uncommitted changes', async () => {
      const { git, calls } = fakeGit({
        ...unchangedRoutes(),
        [`-C /wt ${pins('/wt')} status --porcelain --untracked-files=no`]: () => ' M app.ts\n',
      });

      expect(
        await createGitBranchService({ git }).resetToLocalBase('/wt', 'main', MERGED, { git }),
      ).toEqual({ base: 'main', skipped: true });
      expect(calls.some((c) => c.includes('checkout') || c.includes('update-ref'))).toBe(false);
    });
  });

  describe('autoRename', () => {
    it('renames a fresh agent branch in place using the generated typed slug', async () => {
      const { git, calls } = fakeGit({
        'rev-parse --abbrev-ref HEAD': () => 'agent/e89dbfe6\n',
        'rev-parse --abbrev-ref --symbolic-full-name @{u}': fails(),
        'show-ref --verify --quiet refs/heads/fix/branch-rename-e89dbfe6': fails(),
        'branch -m fix/branch-rename-e89dbfe6': () => '',
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });

      await expect(svc.autoRename('/wt', 'fix/branch-rename')).resolves.toBe(
        'fix/branch-rename-e89dbfe6',
      );
      expect(calls).toContainEqual(['-C', '/wt', 'branch', '-m', 'fix/branch-rename-e89dbfe6']);
    });

    it('preserves the issue number and short id when renaming an issue branch', async () => {
      const { git } = fakeGit({
        'rev-parse --abbrev-ref HEAD': () => 'feat/137-1234abcd\n',
        'rev-parse --abbrev-ref --symbolic-full-name @{u}': fails(),
        'show-ref --verify --quiet refs/heads/fix/137-better-title-1234abcd': fails(),
        'branch -m fix/137-better-title-1234abcd': () => '',
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });

      await expect(svc.autoRename('/wt', 'fix/better-title')).resolves.toBe(
        'fix/137-better-title-1234abcd',
      );
    });

    it('skips issue-shaped branches that already carry a slug', async () => {
      const { git, calls } = fakeGit({
        'rev-parse --abbrev-ref HEAD': () => 'feat/137-existing-work-1234abcd\n',
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });

      await expect(svc.autoRename('/wt', 'fix/better-title')).resolves.toBeNull();
      expect(calls).toHaveLength(1);
    });

    it('skips pushed branches with an upstream', async () => {
      const { git, calls } = fakeGit({
        'rev-parse --abbrev-ref HEAD': () => 'agent/e89dbfe6\n',
        'rev-parse --abbrev-ref --symbolic-full-name @{u}': () => 'origin/agent/e89dbfe6\n',
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });

      await expect(svc.autoRename('/wt', 'fix/branch-rename')).resolves.toBeNull();
      expect(calls.some((c) => c.includes('branch') && c.includes('-m'))).toBe(false);
    });

    it('skips branches that were not minted by Verity spawn naming', async () => {
      const { git, calls } = fakeGit({
        'rev-parse --abbrev-ref HEAD': () => 'main\n',
      });
      const svc = createGitBranchService({ repoDir: '/repo', git });

      await expect(svc.autoRename('/wt', 'fix/branch-rename')).resolves.toBeNull();
      expect(calls).toHaveLength(1);
    });
  });
});

/**
 * The pins above are asserted as argv in the unit tests; this exercises them against a
 * REAL git, in the shape the threat model describes: a session that wrote its own
 * `.git/config` into the clone. What is at stake here is no longer where the programs
 * run — they run in the sandbox — but whether an operator-initiated merge still does the
 * same thing in a repository that has configured git against it: land in the clone, and
 * not be vetoed or rewritten. Two capabilities are covered — running a program
 * (`core.hooksPath`, `core.fsmonitor`) and redirecting where git writes (`core.worktree`)
 * — and each fixture is proved live first, so the test fails if a git version stops
 * honouring the setting rather than silently passing.
 */
describe('mergeIntoLocalBase against a hostile repository (real git)', () => {
  /** Stands in for the in-sandbox runner. `createSandboxGit` adds a `docker exec` prefix
   *  and nothing else, so the argv reaching git is the argv reaching this one. */
  const realGit: GitOutput = async (args) => execFileSync('git', [...args], { encoding: 'utf8' });

  /** A repo whose shared config points hooks, the fsmonitor, and the working tree at
   *  attacker-chosen paths, with `feat/x` ahead of `main` in a linked worktree. */
  function hostileClone(): {
    dir: string;
    base: string;
    worktree: string;
    outside: string;
    fired: () => string[];
  } {
    const dir = mkdtempSync(join(tmpdir(), 'verity-hostile-merge-'));
    const base = join(dir, 'clone');
    const worktree = join(dir, 'wt');
    const outside = join(dir, 'outside'); // stands in for any host path
    const fired = join(dir, 'fired');
    mkdirSync(outside);
    mkdirSync(fired);
    const git = (cwd: string, ...args: string[]): string =>
      execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@e', ...args], {
        encoding: 'utf8',
      });

    execFileSync('git', ['init', '-q', '-b', 'main', base]);
    git(base, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(base, 'worktree', 'add', '-q', worktree, '-b', 'feat/x');
    writeFileSync(join(worktree, 'session.txt'), 'work from the session\n');
    git(worktree, 'add', 'session.txt');
    git(worktree, 'commit', '-q', '-m', 'session work');

    // The payloads: one marker file per program git is talked into running.
    const hooks = join(dir, 'hooks');
    mkdirSync(hooks);
    for (const hook of [
      'pre-merge-commit',
      'post-merge',
      'post-commit',
      'post-checkout',
      'reference-transaction',
    ]) {
      writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch ${join(fired, hook)}\n`, { mode: 0o755 });
    }
    const fsmonitor = join(dir, 'fsmonitor.sh');
    writeFileSync(fsmonitor, `#!/bin/sh\ntouch ${join(fired, 'fsmonitor')}\nexit 1\n`, {
      mode: 0o755,
    });
    git(base, 'config', 'core.hooksPath', hooks);
    git(base, 'config', 'core.fsmonitor', fsmonitor);
    git(base, 'config', 'core.worktree', outside);

    return { dir, base, worktree, outside, fired: () => readdirSync(fired).sort() };
  }

  it('runs no configured program and writes only inside the clone', async () => {
    const { dir, base, worktree, outside, fired } = hostileClone();
    try {
      // The fixture is live: unpinned, this git resolves the working tree to `outside`.
      expect(
        execFileSync('git', ['-C', base, 'rev-parse', '--show-toplevel'], {
          encoding: 'utf8',
        }).trim(),
      ).toBe(outside);

      const svc = createGitBranchService({});
      const merged = await svc.mergeIntoLocalBase(worktree, base, { git: realGit });
      expect(merged.base).toBe('main');
      expect(merged.branch).toBe('feat/x');

      // The merge landed in the clone, not in the redirected path.
      expect(existsSync(join(base, 'session.txt'))).toBe(true);
      expect(readdirSync(outside)).toEqual([]);
      expect(fired()).toEqual([]);

      const reset = await svc.resetToLocalBase(worktree, 'main', merged, {
        git: realGit,
      });
      expect(reset).toEqual({ base: 'main', deletedBranch: 'feat/x' });
      // Real git accepted the tip the merge reported, and the worktree sits on it.
      expect(
        execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      ).toBe(merged.baseTip);
      expect(readdirSync(outside)).toEqual([]);
      expect(fired()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // `git branch` refuses to create such a name, but the plumbing does not: a session can
  // point its worktree HEAD at one, and `rev-parse --abbrev-ref HEAD` hands it back.
  it('refuses a session branch whose name real git would read as an option', async () => {
    const { dir, base, worktree } = hostileClone();
    try {
      const head = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim();
      execFileSync('git', ['-C', worktree, 'update-ref', 'refs/heads/-x', head]);
      execFileSync('git', ['-C', worktree, 'symbolic-ref', 'HEAD', 'refs/heads/-x']);
      expect(
        execFileSync('git', ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
      ).toBe('-x');

      await expect(
        createGitBranchService({}).mergeIntoLocalBase(worktree, base, { git: realGit }),
      ).rejects.toThrow(InvalidBranchNameError);
      expect(existsSync(join(base, 'session.txt'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // `filter.<name>.clean` names a program, and its key carries an arbitrary name, so it
  // cannot be pinned away on argv. Verity used to refuse the merge over it — the scan was
  // read-then-run, and a session could install the filter between the two. Now the merge
  // runs in the sandbox, where that program is the session's own and already allowed, so
  // the merge simply proceeds. Nothing else may become conditional on the config, which
  // is what this pins down.
  it('merges a repository whose config names a content filter', async () => {
    const { dir, base, worktree, fired } = hostileClone();
    try {
      execFileSync('git', [
        '-C',
        base,
        'config',
        'filter.evil.clean',
        `sh -c 'touch ${join(dir, 'fired', 'filter')}'`,
      ]);

      await expect(
        createGitBranchService({}).mergeIntoLocalBase(worktree, base, { git: realGit }),
      ).resolves.toMatchObject({ base: 'main', branch: 'feat/x' });
      expect(existsSync(join(base, 'session.txt'))).toBe(true);
      // No `.gitattributes` selects the filter, so it stays unused here — as do the
      // hooks and the fsmonitor, which the pins disable outright.
      expect(fired()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
