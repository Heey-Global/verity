import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createGitWorktreeProvisioner,
  linkWorkspacePackages,
  mirrorNestedNodeModules,
  redactAuthHeader,
  repairAdminGitdirs,
  reregisterPrunedWorktrees,
  repairProjectAdminGitdirs,
  type GitRunner,
} from './worktree.js';

describe('createGitWorktreeProvisioner', () => {
  function tempRoot(): string {
    return mkdtempSync(join(tmpdir(), 'verity-worktree-test-'));
  }

  it('adds a worktree on a new branch off the base, returning a path under the root', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push([...args]);
    };
    const root = tempRoot();
    const provisioner = createGitWorktreeProvisioner({
      repoDir: '/work',
      worktreeRoot: root,
      baseBranch: 'main',
      git,
    });

    const path = await provisioner.add('agent/add-settings');

    expect(path).toBe(join(root, 'agent-add-settings')); // one segment, sanitized
    expect(calls[0]).toEqual([
      '-C',
      '/work',
      'worktree',
      'add',
      join(root, 'agent-add-settings'),
      '-b',
      'agent/add-settings',
      'main',
    ]);
  });

  it('with refreshBase, fetches the base from origin and branches off FETCH_HEAD', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push([...args]);
    };
    const root = tempRoot();
    const provisioner = createGitWorktreeProvisioner({
      repoDir: '/work',
      worktreeRoot: root,
      baseBranch: 'main',
      refreshBase: true,
      git,
    });

    await provisioner.add('agent/fresh');

    expect(calls[0]).toEqual(['-C', '/work', 'remote', 'get-url', 'origin']); // origin exists?
    expect(calls[1]).toEqual(['-C', '/work', 'fetch', 'origin', 'main']);
    expect(calls[2]).toEqual([
      '-C',
      '/work',
      'worktree',
      'add',
      join(root, 'agent-fresh'),
      '-b',
      'agent/fresh',
      'FETCH_HEAD', // the just-fetched tip, not the stale local ref
    ]);
    // AFTER the add, FF the local `main` ref up to the just-fetched tip too
    // (local, no network, via the freshly-updated tracking ref) so a later
    // `main...HEAD` review scope isn't inflated by a stale local `main`.
    expect(calls[3]).toEqual([
      '-C',
      '/work',
      'fetch',
      '.',
      'refs/remotes/origin/main:refs/heads/main',
    ]);
  });

  it('with refreshBase, falls back to the local base when there is no origin remote', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      if (args.includes('remote')) throw new Error("fatal: No such remote 'origin'");
      if (args.includes('fetch')) throw new Error('should not fetch without an origin remote');
      calls.push([...args]);
    };
    const root = tempRoot();
    const provisioner = createGitWorktreeProvisioner({
      repoDir: '/work',
      worktreeRoot: root,
      baseBranch: 'main',
      refreshBase: true,
      git,
    });

    // A scratch/offline clone with no remote must not hard-fail the spawn.
    await provisioner.add('agent/offline');

    expect(calls[0]).toEqual([
      '-C',
      '/work',
      'worktree',
      'add',
      join(root, 'agent-offline'),
      '-b',
      'agent/offline',
      'main', // fell back to the local base ref
    ]);
  });

  it('with refreshBase, hard-fails (after retry) when origin exists but the fetch fails', async () => {
    let fetches = 0;
    let worktreeAdded = false;
    const git: GitRunner = async (args) => {
      if (args.includes('remote')) return; // origin exists
      if (args.includes('fetch')) {
        fetches += 1;
        throw new Error('fatal: unable to connect to origin (VPN down)');
      }
      if (args.includes('rev-parse')) return;
      if (args.includes('worktree') && args.includes('add')) worktreeAdded = true;
    };
    const root = tempRoot();
    const provisioner = createGitWorktreeProvisioner({
      repoDir: '/work',
      worktreeRoot: root,
      baseBranch: 'main',
      refreshBase: true,
      git,
    });

    // Refuse to branch off a possibly-stale local main — surface it instead.
    await expect(provisioner.add('agent/flaky')).rejects.toThrow(/refusing to branch off/);
    expect(fetches).toBe(2); // one retry before giving up
    expect(worktreeAdded).toBe(false); // never branched off stale base
  });

  it('reports an unborn repository instead of a stale-base warning', async () => {
    let fetches = 0;
    const git: GitRunner = async (args) => {
      if (args.includes('remote')) return;
      if (args.includes('fetch')) {
        fetches += 1;
        throw new Error('fatal: could not find remote ref HEAD');
      }
      if (args.includes('rev-parse')) throw new Error('fatal: Needed a single revision');
    };
    const provisioner = createGitWorktreeProvisioner({
      repoDir: '/work',
      worktreeRoot: tempRoot(),
      baseBranch: 'HEAD',
      refreshBase: true,
      git,
    });

    await expect(provisioner.add('agent-empty')).rejects.toThrow(/repository has no commits yet/);
    expect(fetches).toBe(2);
  });

  it('with fetchAuthHeader, injects `-c http.extraheader=<header>` before the fetch', async () => {
    const header = 'Authorization: Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0LXRva2Vu';
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push([...args]);
    };
    const root = tempRoot();
    const provisioner = createGitWorktreeProvisioner({
      repoDir: '/clone',
      worktreeRoot: root,
      baseBranch: 'main',
      refreshBase: true,
      fetchAuthHeader: async () => header,
      git,
    });

    await provisioner.add('agent/auth');

    expect(calls[0]).toEqual(['-C', '/clone', 'remote', 'get-url', 'origin']); // origin exists?
    // The fetch carries the project token via `-c http.extraheader=…` BEFORE
    // the `fetch origin <base>` verb — authenticating with the project-scoped
    // token instead of the container's narrow global git credential.
    expect(calls[1]).toEqual([
      '-C',
      '/clone',
      '-c',
      `http.extraheader=${header}`,
      'fetch',
      'origin',
      'main',
    ]);
    expect(calls[2]?.slice(0, 4)).toEqual(['-C', '/clone', 'worktree', 'add']);
    // The local FF of `main` follows the add and is a local fetch — it carries
    // NO auth header (no network).
    expect(calls[3]).toEqual([
      '-C',
      '/clone',
      'fetch',
      '.',
      'refs/remotes/origin/main:refs/heads/main',
    ]);
  });

  it('without fetchAuthHeader, keeps the tokenless fetch (the /work server-worktree path)', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push([...args]);
    };
    const root = tempRoot();
    const provisioner = createGitWorktreeProvisioner({
      repoDir: '/work',
      worktreeRoot: root,
      baseBranch: 'main',
      refreshBase: true,
      git,
    });

    await provisioner.add('agent/plain');

    // No `-c http.extraheader` — the tokenless fetch is preserved unchanged.
    expect(calls[1]).toEqual(['-C', '/work', 'fetch', 'origin', 'main']);
    expect(calls[1]).not.toContain('-c');
    expect(calls[1]?.some((a) => a.startsWith('http.extraheader='))).toBe(false);
  });

  it('with fetchAuthHeader returning empty, runs the tokenless fetch (no `-c`)', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push([...args]);
    };
    const root = tempRoot();
    const provisioner = createGitWorktreeProvisioner({
      repoDir: '/clone',
      worktreeRoot: root,
      baseBranch: 'main',
      refreshBase: true,
      // Mint returned no token (e.g. App creds unavailable) → tokenless fetch.
      fetchAuthHeader: async () => undefined,
      git,
    });

    await provisioner.add('agent/empty');

    expect(calls[1]).toEqual(['-C', '/clone', 'fetch', 'origin', 'main']);
  });

  it('resolves fetchAuthHeader FRESH per add (rotated short-TTL token)', async () => {
    const headers = [
      'Authorization: Basic aGVhZGVyLW9uZQ==',
      'Authorization: Basic aGVhZGVyLXR3bw==',
    ];
    let mintCalls = 0;
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push([...args]);
    };
    const root = tempRoot();
    const provisioner = createGitWorktreeProvisioner({
      repoDir: '/clone',
      worktreeRoot: root,
      baseBranch: 'main',
      refreshBase: true,
      fetchAuthHeader: async () => headers[mintCalls++],
      git,
    });

    await provisioner.add('agent/one');
    await provisioner.add('agent/two');

    expect(mintCalls).toBe(2); // resolved once per add, not cached
    // Only the ORIGIN fetches carry the header; the local `main` FF (`fetch .`)
    // is network-free and headerless, so exclude it when checking rotation.
    const fetches = calls.filter((c) => c.includes('fetch') && c.includes('origin'));
    expect(fetches[0]).toContain(`http.extraheader=${headers[0]}`);
    expect(fetches[1]).toContain(`http.extraheader=${headers[1]}`);
  });

  it('redacts the auth header from a fetch failure so the token never leaks', async () => {
    const token = 'ghs_supersecrettoken1234567890';
    const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`;
    const git: GitRunner = async (args) => {
      if (args.includes('remote')) return; // origin exists
      if (args.includes('fetch')) {
        // A real git error echoes the full `-c http.extraheader=…` back.
        throw new Error(
          `fatal: could not read Username; git -c http.extraheader=${header} fetch failed`,
        );
      }
    };
    const root = tempRoot();
    const provisioner = createGitWorktreeProvisioner({
      repoDir: '/clone',
      worktreeRoot: root,
      baseBranch: 'main',
      refreshBase: true,
      fetchAuthHeader: async () => header,
      git,
    });

    const rejection = await provisioner.add('agent/leak').catch((e: unknown) => e);

    expect(rejection).toBeInstanceOf(Error);
    const message = (rejection as Error).message;
    // Neither the raw token, its base64 credential, nor the full header survive.
    expect(message).not.toContain(token);
    expect(message).not.toContain(header);
    expect(message).toContain('[redacted]');
    expect(message).toMatch(/refusing to branch off/); // hard-fail preserved
  });

  it('(integration, real git) fast-forwards the stale local base ref to the fetched tip', async () => {
    // The bug: refreshBase branches off the freshly-fetched FETCH_HEAD but left
    // the local `main` ref untouched, so it drifted behind origin/main. A later
    // `main...HEAD` (review scope, status chip) then measured against a stale
    // base and pulled already-merged foreign commits into the diff.
    const origin = mkdtempSync(join(tmpdir(), 'verity-worktree-origin-'));
    const ogit = (...args: string[]) =>
      execFileSync('git', ['-C', origin, ...args], { encoding: 'utf8' });
    ogit('init', '-q', '-b', 'main');
    ogit('config', 'user.email', 'test@example.com');
    ogit('config', 'user.name', 'Test');
    ogit('config', 'commit.gpgsign', 'false');
    writeFileSync(join(origin, 'A.txt'), 'a\n');
    ogit('add', '.');
    ogit('commit', '-q', '-m', 'A', '--no-gpg-sign');

    // Clone → local `main` and `origin/main` both at A.
    const repo = mkdtempSync(join(tmpdir(), 'verity-worktree-clone-'));
    execFileSync('git', ['clone', '-q', origin, repo], { encoding: 'utf8' });
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('config', 'commit.gpgsign', 'false');
    // Mirror the real setup: the source checkout sits on a FEATURE branch, so the
    // local `main` ref is free to be fast-forwarded (git refuses to fetch into a
    // checked-out branch — the intended guard when the checkout IS on main).
    git('checkout', '-q', '-b', 'local-work');

    // Advance origin past the clone: local `main` is now stale (behind by one).
    writeFileSync(join(origin, 'B.txt'), 'b\n');
    ogit('add', '.');
    ogit('commit', '-q', '-m', 'B', '--no-gpg-sign');
    const originTip = ogit('rev-parse', 'main').trim();
    expect(git('rev-parse', 'main').trim()).not.toBe(originTip); // stale before spawn

    const provisioner = createGitWorktreeProvisioner({
      repoDir: repo,
      worktreeRoot: join(repo, '.verity-sessions'),
      baseBranch: 'main',
      refreshBase: true,
    });
    const worktree = await provisioner.add('agent/scope');

    // Local `main` was fast-forwarded to the fetched tip...
    expect(git('rev-parse', 'main').trim()).toBe(originTip);
    // ...and the worktree branched off that same fresh tip.
    expect(
      execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    ).toBe(originTip);
  });

  it('rewrites the worktree .git relative but leaves the admin gitdir absolute', async () => {
    const repo = tempRoot();
    mkdirSync(join(repo, '.git', 'worktrees'), { recursive: true });
    const provisioner = createGitWorktreeProvisioner({
      repoDir: repo,
      worktreeRoot: join(repo, '.verity-sessions'),
      baseBranch: 'main',
      git: async (args) => {
        const worktreePath = args[4] as string;
        const name = 'agent-container-paths';
        mkdirSync(worktreePath, { recursive: true });
        mkdirSync(join(repo, '.git', 'worktrees', name), { recursive: true });
        writeFileSync(join(worktreePath, '.git'), `gitdir: ${repo}/.git/worktrees/${name}\n`);
        writeFileSync(join(repo, '.git', 'worktrees', name, 'gitdir'), `${worktreePath}/.git\n`);
      },
    });

    const worktree = await provisioner.add('agent/container-paths');

    // The worktree-side link is relative so the checkout survives a container
    // bind mount at a different absolute prefix (#207).
    expect(readFileSync(join(worktree, '.git'), 'utf8')).toBe(
      'gitdir: ../../.git/worktrees/agent-container-paths\n',
    );
    // The admin-side link back to the worktree is LEFT ABSOLUTE: git resolves a
    // relative value here as a literal path from repoDir, finds nothing, and
    // marks the worktree `prunable` — so a sibling `git worktree add` would sweep
    // a live session. See the real-git regression below.
    expect(
      readFileSync(join(repo, '.git', 'worktrees', 'agent-container-paths', 'gitdir'), 'utf8'),
    ).toBe(`${join(repo, '.verity-sessions', 'agent-container-paths')}/.git\n`);
  });

  it('(integration, real git) provisions a worktree that git does not consider prunable', async () => {
    // The original bug: relativizing the admin `gitdir` made git treat the
    // worktree as prunable, so the next `git worktree add`/`prune`/gc silently
    // deregistered a still-live session. This exercises real git end-to-end.
    const repo = mkdtempSync(join(tmpdir(), 'verity-worktree-real-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'README.md'), '# t\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init', '--no-gpg-sign');

    const provisioner = createGitWorktreeProvisioner({
      repoDir: repo,
      worktreeRoot: join(repo, '.verity-sessions'),
      baseBranch: 'main',
    });
    const worktree = await provisioner.add('agent/real');

    // Worktree-side link is relative (bind-mount portable)...
    expect(readFileSync(join(worktree, '.git'), 'utf8')).toMatch(/^gitdir: \.\.\//);
    // ...and git does NOT want to prune it, so a sibling spawn cannot sweep it.
    expect(git('worktree', 'prune', '--dry-run', '--verbose')).toBe('');
    expect(git('worktree', 'list', '--porcelain')).not.toContain('prunable');
    // The checkout resolves normally from inside.
    expect(
      execFileSync('git', ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('agent/real');

    // And removal still works end-to-end.
    await provisioner.remove(worktree);
    expect(existsSync(worktree)).toBe(false);
  });

  it('(integration, real git) heals a container-prefixed admin gitdir back out of prunable', async () => {
    // The regression that swept 30 live session worktrees in one gc pass: the
    // admin `gitdir` held a container-side `/work/...` path. Absolute, so the old
    // heal skipped it — but not resolvable host-side, so git called the worktree
    // prunable and the next prune deregistered a live session. Real git, so the
    // prunable verdict is git's own, not our reading of it.
    const repo = mkdtempSync(join(tmpdir(), 'verity-worktree-heal-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'README.md'), '# t\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init', '--no-gpg-sign');

    const provisioner = createGitWorktreeProvisioner({
      repoDir: repo,
      worktreeRoot: join(repo, '.verity-sessions'),
      baseBranch: 'main',
    });
    const worktree = await provisioner.add('agent/heal');
    const name = basename(worktree);
    const adminGitdir = join(repo, '.git', 'worktrees', name, 'gitdir');
    writeFileSync(adminGitdir, `/work/.verity-sessions/${name}/.git\n`);
    expect(git('worktree', 'list', '--porcelain')).toContain('prunable');

    repairAdminGitdirs(repo, join(repo, '.verity-sessions'));

    expect(git('worktree', 'prune', '--dry-run', '--verbose')).toBe('');
    expect(git('worktree', 'list', '--porcelain')).not.toContain('prunable');
    expect(
      execFileSync('git', ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('agent/heal');
  });

  it('(integration, real git) rebuilds a live session whose admin entry a prune deleted', async () => {
    // The incident this exists for: host and container see the repo under
    // different absolute prefixes, so `git worktree prune` from either side
    // deregistered every checkout belonging to the other — three live sessions
    // at once, each left with "fatal: not a git repository". The rotted-link
    // heal cannot fix that: after a prune there is no link left to repair.
    const repo = mkdtempSync(join(tmpdir(), 'verity-worktree-prune-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'README.md'), '# t\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init', '--no-gpg-sign');

    const provisioner = createGitWorktreeProvisioner({
      repoDir: repo,
      worktreeRoot: join(repo, '.verity-sessions'),
      baseBranch: 'main',
    });
    const worktree = await provisioner.add('agent/pruned');
    const name = basename(worktree);
    writeFileSync(join(worktree, 'work.txt'), 'uncommitted work\n');

    // Back the facts up while the entry is healthy, exactly as a spawn does.
    reregisterPrunedWorktrees(repo, join(repo, '.verity-sessions'));

    // What a prune from the other namespace does to a live checkout.
    rmSync(join(repo, '.git', 'worktrees', name), { recursive: true, force: true });
    expect(() => execFileSync('git', ['-C', worktree, 'status'], { encoding: 'utf8' })).toThrow();

    expect(reregisterPrunedWorktrees(repo, join(repo, '.verity-sessions'))).toEqual([name]);

    expect(git('worktree', 'list', '--porcelain')).not.toContain('prunable');
    expect(
      execFileSync('git', ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('agent/pruned');
    // The checkout's pending work must survive the rebuild untouched.
    expect(
      execFileSync('git', ['-C', worktree, 'status', '--short'], { encoding: 'utf8' }),
    ).toContain('work.txt');
  });

  /**
   * A real repo with one commit and one provisioned session checkout — where
   * every rebuild test starts before it breaks something. Returns the session's
   * own `git` alongside the repo's, since these tests care about what the
   * checkout reports about itself.
   */
  async function repoWithSession(
    prefix: string,
    branch: string,
  ): Promise<{
    repo: string;
    worktree: string;
    name: string;
    git: (...args: string[]) => string;
    inWorktree: (...args: string[]) => string;
  }> {
    const repo = mkdtempSync(join(tmpdir(), prefix));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'README.md'), '# t\n');
    // As the real repo does, so a checkout's own bookkeeping never shows up as
    // pending work in what these tests read out of `git status`.
    writeFileSync(
      join(repo, '.gitignore'),
      '.verity-sessions/\n.verity-worktree.json\n.verity-worktree.json.tmp\n',
    );
    git('add', '.');
    git('commit', '-q', '-m', 'init', '--no-gpg-sign');

    const provisioner = createGitWorktreeProvisioner({
      repoDir: repo,
      worktreeRoot: join(repo, '.verity-sessions'),
      baseBranch: 'main',
    });
    const worktree = await provisioner.add(branch);
    return {
      repo,
      worktree,
      name: basename(worktree),
      git,
      inWorktree: (...args: string[]) =>
        execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8' }).trim(),
    };
  }

  /** The prune that deregisters a live checkout, as run from the other namespace. */
  const deregister = (repo: string, name: string) =>
    rmSync(join(repo, '.git', 'worktrees', name), { recursive: true, force: true });

  const sweep = (repo: string) => reregisterPrunedWorktrees(repo, join(repo, '.verity-sessions'));

  it('(integration, real git) restores the index, so a rebuilt checkout is not read as wholly deleted', async () => {
    // The incident: a rebuilt entry had no index, and a missing index is an
    // EMPTY index — every tracked file reads as staged for deletion. `git
    // status` showed all 976 files as `D`, and a `git commit -a` from the
    // session would have recorded exactly that tree.
    const { repo, worktree, name, inWorktree } = await repoWithSession(
      'verity-worktree-index-',
      'agent/index',
    );
    writeFileSync(join(worktree, 'work.txt'), 'uncommitted work\n');
    sweep(repo);
    deregister(repo, name);

    expect(sweep(repo)).toEqual([name]);

    expect(inWorktree('diff', '--cached', '--name-only')).toBe('');
    const status = inWorktree('status', '--short');
    expect(status).not.toContain('README.md');
    // And the work that was never committed is still exactly what stands out.
    expect(status).toContain('work.txt');
  });

  it('(integration, real git) rebuilds a detached checkout onto the commit it was left on', async () => {
    // Verity detaches a session's worktree onto the branch its PR merged into,
    // so "no branch" is a normal end state here. A record that could only hold a
    // branch name kept naming the merged one, and a rebuild would have rewound
    // the checkout to it — behind the base it had just been moved to.
    const { repo, worktree, name, inWorktree } = await repoWithSession(
      'verity-worktree-detached-',
      'agent/detached',
    );
    writeFileSync(join(worktree, 'feature.txt'), 'work\n');
    execFileSync('git', ['-C', worktree, 'add', 'feature.txt'], { encoding: 'utf8' });
    execFileSync('git', ['-C', worktree, 'commit', '-q', '-m', 'feature', '--no-gpg-sign']);
    const branchTip = inWorktree('rev-parse', 'HEAD');
    execFileSync('git', ['-C', worktree, 'checkout', '-q', '--detach', 'main']);
    const detachedAt = inWorktree('rev-parse', 'HEAD');
    expect(detachedAt).not.toBe(branchTip);

    sweep(repo);
    deregister(repo, name);

    expect(sweep(repo)).toEqual([name]);
    expect(inWorktree('rev-parse', 'HEAD')).toBe(detachedAt);
    expect(inWorktree('rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
  });

  it('(integration, real git) rebuilds onto the recorded commit when the branch itself is gone', async () => {
    // The window post-merge cleanup opens: the record still names the feature
    // branch, and between the detach and the next sweep that branch is deleted.
    // `ref:` at a deleted branch would make the checkout an UNBORN one — git
    // reports no commits, the whole tree reads as untracked, and the session's
    // next commit starts the branch over instead of continuing it.
    const { repo, worktree, name, git, inWorktree } = await repoWithSession(
      'verity-worktree-gonebranch-',
      'agent/gone',
    );
    writeFileSync(join(worktree, 'feature.txt'), 'work\n');
    execFileSync('git', ['-C', worktree, 'add', 'feature.txt'], { encoding: 'utf8' });
    execFileSync('git', ['-C', worktree, 'commit', '-q', '-m', 'feature', '--no-gpg-sign']);
    const merged = inWorktree('rev-parse', 'HEAD');
    sweep(repo); // records the branch AND the commit it stood on

    execFileSync('git', ['-C', worktree, 'checkout', '-q', '--detach', 'HEAD']);
    git('branch', '-D', 'agent/gone');
    deregister(repo, name);

    expect(sweep(repo)).toEqual([name]);
    expect(inWorktree('rev-parse', 'HEAD')).toBe(merged);
    expect(inWorktree('status', '--short')).toBe('');
  });

  it('(integration, real git) leaves the entry deregistered when the index cannot be restored', async () => {
    // A record aimed at a commit this repo does not have — the branch gone and
    // its objects with it. Registering the entry anyway would produce exactly
    // the indexless checkout this whole change exists to prevent, so the
    // rebuild backs itself out: nothing on disk is lost, the session reports
    // its workspace as missing rather than as 976 deleted files, and the next
    // sweep is free to try again.
    const { repo, worktree, name, git, inWorktree } = await repoWithSession(
      'verity-worktree-unrestorable-',
      'agent/unrestorable',
    );
    writeFileSync(
      join(worktree, '.verity-worktree.json'),
      `${JSON.stringify({
        adminName: name,
        headRef: 'refs/heads/agent/unrestorable',
        headSha: '0123456789012345678901234567890123456789',
      })}\n`,
    );
    execFileSync('git', ['-C', worktree, 'checkout', '-q', '--detach', 'HEAD']);
    git('branch', '-D', 'agent/unrestorable');
    deregister(repo, name);

    expect(sweep(repo)).toEqual([]);
    expect(existsSync(join(repo, '.git', 'worktrees', name))).toBe(false);
    expect(() => inWorktree('status', '--short')).toThrow();
    expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('# t\n');
  });

  it('(integration, real git) keeps the last known commit when the ref cannot be resolved', async () => {
    // The record is the only fallback a rebuild has once the branch is gone, so
    // a refresh that cannot resolve the ref right now must not drop it: a ref
    // store read mid-update would otherwise leave the checkout unrecoverable
    // from the next prune onwards.
    const { repo, worktree, name, inWorktree } = await repoWithSession(
      'verity-worktree-keepsha-',
      'agent/keepsha',
    );
    sweep(repo);
    const recorded = JSON.parse(
      readFileSync(join(worktree, '.verity-worktree.json'), 'utf8'),
    ) as Record<string, string>;
    expect(recorded.headSha).toBe(inWorktree('rev-parse', 'HEAD'));

    // Same branch, no longer resolvable.
    writeFileSync(join(repo, '.git', 'worktrees', name, 'HEAD'), `ref: ${recorded.headRef}\n`);
    rmSync(join(repo, '.git', 'refs', 'heads', 'agent', 'keepsha'), { force: true });

    sweep(repo);
    expect(JSON.parse(readFileSync(join(worktree, '.verity-worktree.json'), 'utf8'))).toEqual(
      recorded,
    );
  });

  it('(integration, real git) keeps an index that outlived the entry it belonged to', async () => {
    // Not every entry dies whole: HEAD can go while the index is still there,
    // and the index is the one part `read-tree HEAD` cannot reproduce — staged
    // work exists nowhere else. So the rebuild supplies what is missing and
    // leaves what is not.
    const { repo, worktree, name, inWorktree } = await repoWithSession(
      'verity-worktree-keepindex-',
      'agent/keepindex',
    );
    writeFileSync(join(worktree, 'staged.txt'), 'picked for the next commit\n');
    execFileSync('git', ['-C', worktree, 'add', 'staged.txt']);
    rmSync(join(repo, '.git', 'worktrees', name, 'HEAD'), { force: true });

    expect(sweep(repo)).toEqual([name]);
    expect(inWorktree('rev-parse', '--abbrev-ref', 'HEAD')).toBe('agent/keepindex');
    expect(inWorktree('diff', '--cached', '--name-only')).toBe('staged.txt');
  });

  it('(integration, real git) refuses an admin name that reaches out of the worktrees dir', async () => {
    // Both sources of the admin name are writable from inside a session, and a
    // rebuild now removes the directory it names when the index will not come
    // back. `.` would aim that at `.git/worktrees` itself — one checkout
    // deregistering every other session in the repo.
    const { repo, worktree, name } = await repoWithSession(
      'verity-worktree-traversal-',
      'agent/traversal',
    );
    const neighbour = await createGitWorktreeProvisioner({
      repoDir: repo,
      worktreeRoot: join(repo, '.verity-sessions'),
      baseBranch: 'main',
    }).add('agent/neighbour');

    writeFileSync(
      join(worktree, '.verity-worktree.json'),
      // Aimed at a commit the repo does not have, so a rebuild that got this
      // far would fail to restore the index and back out over `worktrees`.
      `${JSON.stringify({ adminName: '.', headRef: '0123456789012345678901234567890123456789' })}\n`,
    );
    writeFileSync(join(worktree, '.git'), 'gitdir: ../../.git/worktrees/.\n');
    deregister(repo, name);

    expect(sweep(repo)).toEqual([]);
    expect(existsSync(join(repo, '.git', 'worktrees', basename(neighbour)))).toBe(true);
    expect(existsSync(join(repo, '.git', 'worktrees', 'HEAD'))).toBe(false);
    expect(
      execFileSync('git', ['-C', neighbour, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('agent/neighbour');
  });

  it('(integration, real git) rebuilds from a record written before commits were tracked', async () => {
    // A sidecar from an older Server holds a branch and nothing else. It is the
    // common case on the first sweep after an update, and it must still rebuild.
    const { repo, worktree, name, inWorktree } = await repoWithSession(
      'verity-worktree-legacy-',
      'agent/legacy',
    );
    writeFileSync(
      join(worktree, '.verity-worktree.json'),
      `${JSON.stringify({ adminName: name, headRef: 'refs/heads/agent/legacy' })}\n`,
    );
    deregister(repo, name);

    expect(sweep(repo)).toEqual([name]);
    expect(inWorktree('rev-parse', '--abbrev-ref', 'HEAD')).toBe('agent/legacy');
  });

  it('(integration, real git) refuses to invent an entry for a checkout with no sidecar', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'verity-worktree-nosidecar-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'README.md'), '# t\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init', '--no-gpg-sign');

    const provisioner = createGitWorktreeProvisioner({
      repoDir: repo,
      worktreeRoot: join(repo, '.verity-sessions'),
      baseBranch: 'main',
    });
    const worktree = await provisioner.add('agent/unknown');
    const name = basename(worktree);
    rmSync(join(worktree, '.verity-worktree.json'), { force: true });
    rmSync(join(repo, '.git', 'worktrees', name), { recursive: true, force: true });

    // A guessed branch would silently move the checkout's work onto the wrong
    // ref, which is worse than leaving it visibly broken for a human.
    expect(reregisterPrunedWorktrees(repo, join(repo, '.verity-sessions'))).toEqual([]);
    expect(existsSync(join(repo, '.git', 'worktrees', name))).toBe(false);
  });

  it('(integration, real git) a spawn heals a rotted sibling so a later prune cannot sweep it', async () => {
    // The incident: a session worktree under `<repo>/.verity-sessions` held a
    // container-side `/work/...` admin gitdir. It rotted while the server was up
    // — so the startup heal had long passed — and stayed `prunable` until a
    // `git worktree prune` deregistered the still-live session mid-turn: commit
    // and push broke with `fatal: not a git repository: .../worktrees/<id>`.
    // Spawns are the frequent heal trigger that closes that window.
    const repo = mkdtempSync(join(tmpdir(), 'verity-worktree-sweep-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'README.md'), '# t\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init', '--no-gpg-sign');

    const projectSessions = createGitWorktreeProvisioner({
      repoDir: repo,
      worktreeRoot: join(repo, '.verity-sessions'),
      baseBranch: 'main',
    });
    const live = await projectSessions.add('agent/live');
    const liveName = basename(live);
    const liveAdminDir = join(repo, '.git', 'worktrees', liveName);
    // Rot exactly as a worktree created inside the session container does.
    writeFileSync(join(liveAdminDir, 'gitdir'), `/work/.verity-sessions/${liveName}/.git\n`);
    expect(git('worktree', 'list', '--porcelain')).toContain('prunable');

    // An unrelated spawn, into a DIFFERENT root — the live session is not under it.
    const spawnRoot = mkdtempSync(join(tmpdir(), 'verity-worktree-spawn-'));
    const spawned = createGitWorktreeProvisioner({
      repoDir: repo,
      worktreeRoot: spawnRoot,
      baseBranch: 'main',
    });
    await spawned.add('agent/spawn');
    expect(git('worktree', 'list', '--porcelain')).not.toContain('prunable');

    // The prune that used to sweep it — now a no-op, and the session survives.
    git('worktree', 'prune');
    expect(existsSync(liveAdminDir)).toBe(true);
    expect(
      execFileSync('git', ['-C', live, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('agent/live');
  });

  it('(integration, real git) isolates workspace resolution to the worktree, not the source repo', async () => {
    // The bug: a worktree has no node_modules of its own, so `@verity/*` resolves
    // through the SOURCE repo's hoisted `node_modules/@verity/* -> ../../packages/*`
    // links — i.e. to the source checkout's copy, whatever branch it's on. A
    // session then typechecks/`require.resolve`s against a different worktree.
    const repo = mkdtempSync(join(tmpdir(), 'verity-worktree-ws-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    // A minimal workspace package that IS committed (so the worktree checks it out).
    mkdirSync(join(repo, 'packages', 'foo'), { recursive: true });
    writeFileSync(
      join(repo, 'packages', 'foo', 'package.json'),
      JSON.stringify({ name: '@verity/foo', version: '0.0.0' }),
    );
    git('add', '.');
    git('commit', '-q', '-m', 'init', '--no-gpg-sign');
    // The hoisted workspace symlink npm would create in the SOURCE repo (not
    // committed — it lives only in the source checkout's node_modules on disk).
    mkdirSync(join(repo, 'node_modules', '@verity'), { recursive: true });
    symlinkSync('../../packages/foo', join(repo, 'node_modules', '@verity', 'foo'));

    const provisioner = createGitWorktreeProvisioner({
      repoDir: repo,
      worktreeRoot: join(repo, '.verity-sessions'),
      baseBranch: 'main',
    });
    const worktree = await provisioner.add('agent/ws');

    // The worktree got its OWN @verity/foo link, with the same relative target...
    const link = join(worktree, 'node_modules', '@verity', 'foo');
    expect(readlinkSync(link)).toBe('../../packages/foo');
    // ...and it resolves to THIS worktree's package, not the source repo's copy.
    expect(realpathSync(link)).toBe(realpathSync(join(worktree, 'packages', 'foo')));
    expect(realpathSync(link)).not.toBe(realpathSync(join(repo, 'packages', 'foo')));
  });

  it('linkWorkspacePackages is a no-op for a non-workspace repo (no links to mirror)', () => {
    // An arbitrary project checkout has no hoisted `node_modules/@verity/*` links,
    // so there is nothing to mirror — the worktree is left untouched.
    const repo = mkdtempSync(join(tmpdir(), 'verity-worktree-plain-'));
    const worktree = mkdtempSync(join(tmpdir(), 'verity-worktree-plain-wt-'));
    linkWorkspacePackages(repo, worktree);
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
  });

  /** A source checkout whose app lives in `platform/` with its own installed
   * dependency tree — the layout the repo-root up-walk cannot serve. */
  function repoWithNestedModules(): { repo: string; worktree: string } {
    const repo = mkdtempSync(join(tmpdir(), 'verity-worktree-nested-'));
    const modules = join(repo, 'platform', 'node_modules');
    // A plain dependency, plus one carrying a compiled native binding.
    mkdirSync(join(modules, 'next', 'dist', 'bin'), { recursive: true });
    writeFileSync(join(modules, 'next', 'dist', 'bin', 'next'), '#!/usr/bin/env node\n');
    mkdirSync(join(modules, 'better-sqlite3', 'build', 'Release'), { recursive: true });
    writeFileSync(join(modules, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'), 'x');
    // A scoped package, and npm's CLI shim pointing at a relative target.
    mkdirSync(join(modules, '@scope', 'pkg'), { recursive: true });
    writeFileSync(join(modules, '@scope', 'pkg', 'package.json'), '{}');
    mkdirSync(join(modules, '.bin'), { recursive: true });
    symlinkSync('../next/dist/bin/next', join(modules, '.bin', 'next'));
    // npm's install state — a plain file, deliberately not mirrored.
    writeFileSync(join(modules, '.package-lock.json'), '{}');
    // The worktree as git would leave it: the subdirectory exists, node_modules does not.
    const worktree = join(repo, '.verity-sessions', 'agent-x');
    mkdirSync(join(worktree, 'platform'), { recursive: true });
    return { repo, worktree };
  }

  it('mirrors a nested node_modules the repo-root up-walk cannot reach', () => {
    const { repo, worktree } = repoWithNestedModules();

    mirrorNestedNodeModules(repo, worktree);

    // Each package is mirrored individually (not the directory as a whole), so a
    // later install in the worktree replaces entries instead of writing through.
    const mirrored = join(worktree, 'platform', 'node_modules', 'next');
    expect(lstatSync(join(worktree, 'platform', 'node_modules')).isDirectory()).toBe(true);
    // A real directory, not a symlink: every dependency path a bundler
    // canonicalizes stays INSIDE the worktree.
    expect(lstatSync(mirrored).isSymbolicLink()).toBe(false);
    expect(realpathSync(mirrored)).toBe(mirrored);
    expect(realpathSync(mirrored)).not.toBe(
      realpathSync(join(repo, 'platform', 'node_modules', 'next')),
    );
    // The dependency is isolated: an in-place agent edit must not mutate the source
    // checkout (or another session). A reflink may share blocks initially, but never
    // the inode.
    const bin = join('dist', 'bin', 'next');
    const mirroredBin = join(mirrored, bin);
    const sourceBin = join(repo, 'platform', 'node_modules', 'next', bin);
    expect(statSync(mirroredBin).ino).not.toBe(statSync(sourceBin).ino);
    writeFileSync(mirroredBin, 'worktree-only\n');
    expect(readFileSync(sourceBin, 'utf8')).toBe('#!/usr/bin/env node\n');
    // Which is the whole point: the compiled binding comes along, so the app that
    // needs it boots without a rebuild the sandbox's ignore-scripts would skip.
    expect(
      existsSync(
        join(
          worktree,
          'platform',
          'node_modules',
          'better-sqlite3',
          'build',
          'Release',
          'better_sqlite3.node',
        ),
      ),
    ).toBe(true);
  });

  it('omits a package it cannot reproduce faithfully instead of sharing it by symlink', () => {
    const { repo, worktree } = repoWithNestedModules();
    // An absolute internal symlink would not survive the bind mount into the
    // sandbox, so the package cannot be copied entry-for-entry. A source symlink
    // would let an agent mutate the main checkout, so fail closed for this package.
    symlinkSync(tmpdir(), join(repo, 'platform', 'node_modules', 'next', 'absolute'));

    mirrorNestedNodeModules(repo, worktree);

    const mirrored = join(worktree, 'platform', 'node_modules', 'next');
    expect(existsSync(mirrored)).toBe(false);
    // No half-built tree survives.
    expect(readdirSync(join(worktree, 'platform', 'node_modules')).sort()).not.toContain('next');
  });

  it('omits a package whose relative internal symlink escapes the package tree', () => {
    const { repo, worktree } = repoWithNestedModules();
    const pkg = join(repo, 'platform', 'node_modules', 'next');
    symlinkSync('../../outside-secret', join(pkg, 'relative-escape'));

    mirrorNestedNodeModules(repo, worktree);

    expect(existsSync(join(worktree, 'platform', 'node_modules', 'next'))).toBe(false);
  });

  it('reproduces .bin shims verbatim so they resolve through the mirrored packages', () => {
    const { repo, worktree } = repoWithNestedModules();

    mirrorNestedNodeModules(repo, worktree);

    // Same relative target as the source — `npm run` puts this .bin on PATH, and
    // it resolves via the worktree's own `next` copy.
    const shim = join(worktree, 'platform', 'node_modules', '.bin', 'next');
    expect(readlinkSync(shim)).toBe('../next/dist/bin/next');
    const target = join(worktree, 'platform', 'node_modules', 'next', 'dist', 'bin', 'next');
    expect(realpathSync(shim)).toBe(realpathSync(target));
    // Isolated from the source checkout even though the shim resolves locally.
    expect(statSync(shim).ino).not.toBe(
      statSync(join(repo, 'platform', 'node_modules', 'next', 'dist', 'bin', 'next')).ino,
    );
    // Scope directories are recreated so their members are mirrored individually.
    const scoped = join(worktree, 'platform', 'node_modules', '@scope', 'pkg', 'package.json');
    expect(statSync(scoped).ino).not.toBe(
      statSync(join(repo, 'platform', 'node_modules', '@scope', 'pkg', 'package.json')).ino,
    );
    // npm's install state stays out: a later install must not trust a tree it
    // does not own.
    expect(existsSync(join(worktree, 'platform', 'node_modules', '.package-lock.json'))).toBe(
      false,
    );
  });

  it('leaves a subdirectory alone when the worktree already installed its own deps', () => {
    const { repo, worktree } = repoWithNestedModules();
    mkdirSync(join(worktree, 'platform', 'node_modules', 'own'), { recursive: true });

    mirrorNestedNodeModules(repo, worktree);

    // Its own install owns resolution — nothing is mirrored on top of it.
    expect(existsSync(join(worktree, 'platform', 'node_modules', 'next'))).toBe(false);
  });

  it('copies real .bin shims so a worktree cannot mutate the shared install', () => {
    const { repo, worktree } = repoWithNestedModules();
    // npm symlinks its shims; pnpm/yarn write shell scripts. Dropping those would
    // leave the dependency's CLI off the `npm run` PATH.
    writeFileSync(
      join(repo, 'platform', 'node_modules', '.bin', 'vite'),
      '#!/bin/sh\nexec node ../vite/bin/vite.js "$@"\n',
    );

    mirrorNestedNodeModules(repo, worktree);

    const shim = join(worktree, 'platform', 'node_modules', '.bin', 'vite');
    const source = join(repo, 'platform', 'node_modules', '.bin', 'vite');
    expect(realpathSync(shim)).not.toBe(realpathSync(source));
    expect(readFileSync(shim, 'utf8')).toBe(readFileSync(source, 'utf8'));
    writeFileSync(shim, '# isolated\n');
    expect(readFileSync(source, 'utf8')).toContain('exec node');
  });

  it('mirrors nested node_modules up to the documented depth bound, and no deeper', () => {
    const repo = mkdtempSync(join(tmpdir(), 'verity-worktree-depth-'));
    const worktree = join(repo, '.verity-sessions', 'agent-x');
    const subAt = (level: number) => Array.from({ length: level }, (_, i) => `l${i + 1}`).join('/');
    for (const level of [1, 2, 3, 4]) {
      mkdirSync(join(repo, subAt(level), 'node_modules', 'dep'), { recursive: true });
      mkdirSync(join(worktree, subAt(level)), { recursive: true });
    }

    mirrorNestedNodeModules(repo, worktree);

    // Three levels covers the layouts worth scanning (`platform/`, `apps/web/`);
    // past that the walk stops rather than trawling the whole tree.
    expect(existsSync(join(worktree, subAt(3), 'node_modules', 'dep'))).toBe(true);
    expect(existsSync(join(worktree, subAt(4), 'node_modules'))).toBe(false);
  });

  it('refuses to write through a symlinked subdirectory in the checked-out branch', () => {
    const { repo, worktree } = repoWithNestedModules();
    // A branch is free to ship `platform` as a symlink to anywhere the server can
    // write. Following it would plant the mirrored tree outside the worktree.
    const outside = mkdtempSync(join(tmpdir(), 'verity-worktree-outside-'));
    rmSync(join(worktree, 'platform'), { recursive: true });
    symlinkSync(outside, join(worktree, 'platform'));

    mirrorNestedNodeModules(repo, worktree);

    expect(existsSync(join(outside, 'node_modules'))).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses to write through a symlinked intermediate path segment', () => {
    // Same escape one level up: the leaf is a real directory, but its parent is a
    // symlink, so only lstat-ing every segment catches it.
    const repo = mkdtempSync(join(tmpdir(), 'verity-worktree-segment-'));
    mkdirSync(join(repo, 'apps', 'web', 'node_modules', 'dep'), { recursive: true });
    const worktree = join(repo, '.verity-sessions', 'agent-x');
    mkdirSync(worktree, { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), 'verity-worktree-outside-seg-'));
    mkdirSync(join(outside, 'web'), { recursive: true });
    symlinkSync(outside, join(worktree, 'apps'));

    mirrorNestedNodeModules(repo, worktree);

    expect(existsSync(join(outside, 'web', 'node_modules'))).toBe(false);
  });

  it('skips the repo root node_modules and other sessions worktrees', () => {
    const repo = mkdtempSync(join(tmpdir(), 'verity-worktree-roots-'));
    // The root tree is already served by Node walking up from the worktree.
    mkdirSync(join(repo, 'node_modules', 'hoisted'), { recursive: true });
    // A sibling session's worktree, which also carries an installed tree.
    mkdirSync(join(repo, '.verity-sessions', 'agent-other', 'platform', 'node_modules', 'stale'), {
      recursive: true,
    });
    const worktree = join(repo, '.verity-sessions', 'agent-x');
    mkdirSync(worktree, { recursive: true });

    mirrorNestedNodeModules(repo, worktree);

    expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
    // Mirroring one session into the next is the leak this must never introduce.
    expect(existsSync(join(worktree, '.verity-sessions'))).toBe(false);
  });

  it('mirrorNestedNodeModules is a no-op for a repo with no nested node_modules', () => {
    const repo = mkdtempSync(join(tmpdir(), 'verity-worktree-flat-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    const worktree = mkdtempSync(join(tmpdir(), 'verity-worktree-flat-wt-'));

    mirrorNestedNodeModules(repo, worktree);

    expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
    expect(existsSync(join(worktree, 'src'))).toBe(false);
  });

  it('defaults the base ref to HEAD', async () => {
    let captured: readonly string[] = [];
    const git: GitRunner = async (args) => {
      captured = args;
    };
    const root = tempRoot();
    const provisioner = createGitWorktreeProvisioner({
      repoDir: '/repo',
      worktreeRoot: root,
      git,
    });
    await provisioner.add('agent/x');
    expect(captured.at(-1)).toBe('HEAD');
  });

  it('sanitizes a branch with path separators to a single directory segment', async () => {
    const git: GitRunner = vi.fn(async () => undefined);
    const root = tempRoot();
    const provisioner = createGitWorktreeProvisioner({ repoDir: '/r', worktreeRoot: root, git });
    // `../escape` must not climb out of the worktree root — it collapses to a
    // single harmless segment (no `.`/`..`).
    const path = await provisioner.add('../../etc/evil');
    expect(path).toBe(join(root, 'etc-evil'));
  });

  it('rejects a branch that has no usable directory name', async () => {
    const git: GitRunner = vi.fn(async () => undefined);
    const root = tempRoot();
    const provisioner = createGitWorktreeProvisioner({ repoDir: '/r', worktreeRoot: root, git });
    await expect(provisioner.add('...')).rejects.toThrow(/no usable worktree directory name/);
    expect(git).not.toHaveBeenCalled();
  });

  it('removes a worktree with --force', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push([...args]);
    };
    const provisioner = createGitWorktreeProvisioner({
      repoDir: '/work',
      worktreeRoot: '/wt',
      git,
    });
    // No readable git metadata at this fake path → no branch to delete.
    await provisioner.remove('/wt/agent-x');
    expect(calls).toEqual([
      ['-C', '/work', 'worktree', 'unlock', '/wt/agent-x'], // drop any lock first
      ['-C', '/work', 'worktree', 'remove', '/wt/agent-x', '--force'],
    ]);
  });

  it('still removes when unlock is refused (worktree was not locked)', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push([...args]);
      if (args.includes('unlock')) throw new Error("fatal: '/wt/agent-x' is not locked");
    };
    const provisioner = createGitWorktreeProvisioner({
      repoDir: '/work',
      worktreeRoot: '/wt',
      git,
    });
    // A not-locked worktree makes `unlock` error — teardown must proceed anyway.
    await expect(provisioner.remove('/wt/agent-x')).resolves.toBeUndefined();
    expect(calls).toEqual([
      ['-C', '/work', 'worktree', 'unlock', '/wt/agent-x'],
      ['-C', '/work', 'worktree', 'remove', '/wt/agent-x', '--force'],
    ]);
  });

  it('deletes the now-orphan branch after removing its worktree', async () => {
    const repo = tempRoot();
    const root = join(repo, '.verity-sessions');
    // Author the git metadata a real worktree would have: `.git` → admin dir,
    // whose HEAD names the branch. Read before removal to know what to drop.
    const worktreePath = join(root, 'agent-done');
    const adminDir = join(repo, '.git', 'worktrees', 'agent-done');
    mkdirSync(worktreePath, { recursive: true });
    mkdirSync(adminDir, { recursive: true });
    writeFileSync(join(worktreePath, '.git'), `gitdir: ${adminDir}\n`);
    writeFileSync(join(adminDir, 'HEAD'), 'ref: refs/heads/agent/done\n');

    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push([...args]);
    };
    const provisioner = createGitWorktreeProvisioner({
      repoDir: repo,
      worktreeRoot: root,
      baseBranch: 'main',
      git,
    });
    await provisioner.remove(worktreePath);

    expect(calls).toEqual([
      ['-C', repo, 'worktree', 'unlock', worktreePath],
      ['-C', repo, 'worktree', 'remove', worktreePath, '--force'],
      ['-C', repo, 'branch', '-d', 'agent/done'], // safe delete: keeps unmerged work
    ]);
  });

  it('never deletes the base branch, even if the worktree is on it', async () => {
    const repo = tempRoot();
    const root = join(repo, '.verity-sessions');
    const worktreePath = join(root, 'main');
    const adminDir = join(repo, '.git', 'worktrees', 'main');
    mkdirSync(worktreePath, { recursive: true });
    mkdirSync(adminDir, { recursive: true });
    writeFileSync(join(worktreePath, '.git'), `gitdir: ${adminDir}\n`);
    writeFileSync(join(adminDir, 'HEAD'), 'ref: refs/heads/main\n');

    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push([...args]);
    };
    const provisioner = createGitWorktreeProvisioner({
      repoDir: repo,
      worktreeRoot: root,
      baseBranch: 'main',
      git,
    });
    await provisioner.remove(worktreePath);

    expect(calls).toEqual([
      ['-C', repo, 'worktree', 'unlock', worktreePath],
      ['-C', repo, 'worktree', 'remove', worktreePath, '--force'],
    ]);
  });

  it('does not delete a branch for a detached-HEAD worktree', async () => {
    const repo = tempRoot();
    const root = join(repo, '.verity-sessions');
    const worktreePath = join(root, 'detached');
    const adminDir = join(repo, '.git', 'worktrees', 'detached');
    mkdirSync(worktreePath, { recursive: true });
    mkdirSync(adminDir, { recursive: true });
    writeFileSync(join(worktreePath, '.git'), `gitdir: ${adminDir}\n`);
    // A detached HEAD is a raw SHA, not `ref: refs/heads/...` — nothing to drop.
    writeFileSync(join(adminDir, 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');

    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push([...args]);
    };
    const provisioner = createGitWorktreeProvisioner({
      repoDir: repo,
      worktreeRoot: root,
      baseBranch: 'main',
      git,
    });
    await provisioner.remove(worktreePath);

    expect(calls).toEqual([
      ['-C', repo, 'worktree', 'unlock', worktreePath],
      ['-C', repo, 'worktree', 'remove', worktreePath, '--force'],
    ]);
  });

  it('keeps teardown succeeding when the branch delete is refused (unmerged)', async () => {
    const repo = tempRoot();
    const root = join(repo, '.verity-sessions');
    const worktreePath = join(root, 'agent-unmerged');
    const adminDir = join(repo, '.git', 'worktrees', 'agent-unmerged');
    mkdirSync(worktreePath, { recursive: true });
    mkdirSync(adminDir, { recursive: true });
    writeFileSync(join(worktreePath, '.git'), `gitdir: ${adminDir}\n`);
    writeFileSync(join(adminDir, 'HEAD'), 'ref: refs/heads/agent/unmerged\n');

    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push([...args]);
      if (args.includes('branch')) throw new Error('error: branch not fully merged');
    };
    const provisioner = createGitWorktreeProvisioner({
      repoDir: repo,
      worktreeRoot: root,
      baseBranch: 'main',
      git,
    });
    // A refused delete must not surface as a teardown failure.
    await expect(provisioner.remove(worktreePath)).resolves.toBeUndefined();
    expect(calls).toEqual([
      ['-C', repo, 'worktree', 'unlock', worktreePath],
      ['-C', repo, 'worktree', 'remove', worktreePath, '--force'],
      ['-C', repo, 'branch', '-d', 'agent/unmerged'],
    ]);
  });

  it('repairs a relative admin gitdir back to the absolute worktree path', () => {
    // Worktrees created by the old code carry an admin gitdir written relative to
    // its own admin dir — which git treats as prunable (see the real-git
    // regression above). The startup heal resolves it there and rewrites the
    // absolute path git expects, so a prune/gc can no longer sweep the session.
    const repo = tempRoot();
    const adminDir = join(repo, '.git', 'worktrees', 'agent-old');
    mkdirSync(adminDir, { recursive: true });
    const relativeGitdir = join('..', '..', '..', '.verity-sessions', 'agent-old', '.git');
    writeFileSync(join(adminDir, 'gitdir'), `${relativeGitdir}\n`);

    repairAdminGitdirs(repo);

    expect(readFileSync(join(adminDir, 'gitdir'), 'utf8')).toBe(
      `${join(repo, '.verity-sessions', 'agent-old', '.git')}\n`,
    );
  });

  it('leaves an already-absolute admin gitdir untouched', () => {
    const repo = tempRoot();
    const adminDir = join(repo, '.git', 'worktrees', 'agent-ok');
    mkdirSync(adminDir, { recursive: true });
    const worktreeGitFile = join(repo, '.verity-sessions', 'agent-ok', '.git');
    mkdirSync(dirname(worktreeGitFile), { recursive: true });
    writeFileSync(worktreeGitFile, 'gitdir: ../../.git/worktrees/agent-ok\n');
    const abs = `${worktreeGitFile}\n`;
    writeFileSync(join(adminDir, 'gitdir'), abs);
    repairAdminGitdirs(repo);
    expect(readFileSync(join(adminDir, 'gitdir'), 'utf8')).toBe(abs);
  });

  it('repairs an admin gitdir left absolute under a container-side prefix', () => {
    // A worktree created from inside a session container writes this side as
    // `/work/.verity-sessions/<id>/.git`. That path is absolute — so the old
    // `isAbsolute` guard skipped it — but does not exist host-side, where git
    // reads it, so the worktree stayed prunable and a gc swept it. The heal
    // inverts the worktree's own relative forward link to recover the real path.
    const repo = tempRoot();
    const adminDir = join(repo, '.git', 'worktrees', 'agent-container');
    mkdirSync(adminDir, { recursive: true });
    writeFileSync(join(adminDir, 'gitdir'), '/work/.verity-sessions/agent-container/.git\n');
    const worktreeGitFile = join(repo, '.verity-sessions', 'agent-container', '.git');
    mkdirSync(dirname(worktreeGitFile), { recursive: true });
    writeFileSync(worktreeGitFile, 'gitdir: ../../.git/worktrees/agent-container\n');

    repairAdminGitdirs(repo);

    expect(readFileSync(join(adminDir, 'gitdir'), 'utf8')).toBe(`${worktreeGitFile}\n`);
  });

  it('recovers the path when the admin dir name is a mangled directory name', () => {
    // git mangles a leading `.` to `-`, so `.tmp-autoresume` is administered as
    // `-tmp-autoresume`. Deriving the checkout path from the admin name would
    // miss it; inverting the forward link does not.
    const repo = tempRoot();
    const adminDir = join(repo, '.git', 'worktrees', '-tmp-autoresume');
    mkdirSync(adminDir, { recursive: true });
    writeFileSync(join(adminDir, 'gitdir'), '/work/.verity-sessions/.tmp-autoresume/.git\n');
    const worktreeGitFile = join(repo, '.verity-sessions', '.tmp-autoresume', '.git');
    mkdirSync(dirname(worktreeGitFile), { recursive: true });
    writeFileSync(worktreeGitFile, 'gitdir: ../../.git/worktrees/-tmp-autoresume\n');

    repairAdminGitdirs(repo);

    expect(readFileSync(join(adminDir, 'gitdir'), 'utf8')).toBe(`${worktreeGitFile}\n`);
  });

  it('leaves a stale admin gitdir untouched when no checkout claims it', () => {
    // The session directory is really gone: there is nothing to point at, and
    // inventing a path would resurrect a dead worktree. Leave it prunable.
    const repo = tempRoot();
    const adminDir = join(repo, '.git', 'worktrees', 'agent-gone');
    mkdirSync(adminDir, { recursive: true });
    const stale = '/work/.verity-sessions/agent-gone/.git\n';
    writeFileSync(join(adminDir, 'gitdir'), stale);

    repairAdminGitdirs(repo);

    expect(readFileSync(join(adminDir, 'gitdir'), 'utf8')).toBe(stale);
  });

  it('propagates a git failure (so the route can clean up + map it)', async () => {
    const git: GitRunner = async () => {
      throw new Error('fatal: branch already exists');
    };
    const root = tempRoot();
    const provisioner = createGitWorktreeProvisioner({ repoDir: '/r', worktreeRoot: root, git });
    await expect(provisioner.add('agent/dup')).rejects.toThrow(/already exists/);
  });
});

describe('redactAuthHeader', () => {
  it('replaces the exact header value with [redacted]', () => {
    const header = 'Authorization: Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0';
    const out = redactAuthHeader(`git -c http.extraheader=${header} fetch failed`, header);
    expect(out).not.toContain(header);
    expect(out).toContain('[redacted]');
  });

  it('scrubs generic Authorization: Basic/Bearer shapes even without the exact header', () => {
    const msg = 'saw Authorization: Basic AbC123+/=._- and Authorization: Bearer tok.en_val';
    const out = redactAuthHeader(msg, undefined);
    expect(out).toBe('saw Authorization: Basic [redacted] and Authorization: Bearer [redacted]');
  });

  it('leaves a message with no header untouched', () => {
    expect(redactAuthHeader('fatal: repository not found', undefined)).toBe(
      'fatal: repository not found',
    );
  });
});

describe('repairProjectAdminGitdirs', () => {
  it('(integration, real git) heals every project clone under the multi-project root', async () => {
    // The multi-project runner leaves `repoDir` empty and keeps one clone per
    // project under `hostCloneRoot`, so the startup heal — gated on `repoDir` —
    // never ran for any project. Every clone kept its landmines.
    const cloneRoot = mkdtempSync(join(tmpdir(), 'verity-clone-root-'));
    const clones: string[] = [];
    for (const project of ['project-a', 'project-b']) {
      const repo = join(cloneRoot, project);
      mkdirSync(repo, { recursive: true });
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      git('config', 'commit.gpgsign', 'false');
      writeFileSync(join(repo, 'README.md'), '# t\n');
      git('add', '.');
      git('commit', '-q', '-m', 'init', '--no-gpg-sign');
      const worktree = await createGitWorktreeProvisioner({
        repoDir: repo,
        worktreeRoot: join(repo, '.verity-sessions'),
        baseBranch: 'main',
      }).add('agent/live');
      const name = basename(worktree);
      writeFileSync(
        join(repo, '.git', 'worktrees', name, 'gitdir'),
        `/work/.verity-sessions/${name}/.git\n`,
      );
      expect(git('worktree', 'list', '--porcelain')).toContain('prunable');
      clones.push(repo);
    }
    // Neighbours that are not project clones must be stepped over, not thrown on.
    mkdirSync(join(cloneRoot, 'not-a-repo'), { recursive: true });
    writeFileSync(join(cloneRoot, 'loose-file'), 'x\n');

    repairProjectAdminGitdirs(cloneRoot);

    for (const repo of clones) {
      expect(
        execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }),
      ).not.toContain('prunable');
    }
  });

  it('is a no-op on a root that does not exist', () => {
    expect(() =>
      repairProjectAdminGitdirs(join(tmpdir(), 'verity-absent-clone-root')),
    ).not.toThrow();
  });
});
