import { execFile } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

// The git wrapper lives at repo-root agent-seed/bin (mounted/baked into
// sandboxes and prepended to PATH). From packages/server/src that is three
// levels up.
const WRAPPER = join(dirname(fileURLToPath(import.meta.url)), '../../../agent-seed/bin/git');

// Resolve the real git by absolute path, NOT via PATH: the shim under test is
// installed first on PATH in real sandboxes, so `command -v git` there would
// resolve back to the shim and recurse.
const REAL_GIT =
  ['/usr/bin/git', '/usr/local/bin/git', '/bin/git'].find((p) => existsSync(p)) ?? '/usr/bin/git';

// Clean, deterministic git config for the throwaway repos: no signing, no
// ambient global/system config, and file-protocol worktrees allowed.
const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

/** Run the real git binary directly (never through the wrapper). */
async function realGit(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync(
    REAL_GIT,
    ['-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args],
    { cwd, env: { ...process.env, ...GIT_ENV } },
  );
}

/** Run the wrapper under bash with the given args, cwd, and extra env. */
async function runWrapper(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stderr: string; stdout: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('bash', [WRAPPER, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV, VERITY_GIT_REAL: REAL_GIT, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stderr?: string; stdout?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stderr: e.stderr ?? '',
      stdout: e.stdout ?? '',
    };
  }
}

let base: string;
let main: string;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'git-guard-'));
  main = join(base, 'main');
  mkdirSync(main);
  await realGit(main, 'init', '-q');
  writeFileSync(join(main, 'a.txt'), 'x');
  await realGit(main, 'add', 'a.txt');
  await realGit(main, 'commit', '-q', '-m', 'init');
  mkdirSync(join(main, '.verity-sessions'));
  await realGit(main, 'worktree', 'add', '-q', '.verity-sessions/agent-test');
  await realGit(main, 'worktree', 'add', '-q', 'sidetree');
});

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

it('ships the guarded Git wrapper unchanged in the toolkit', () => {
  const shipped = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../features/verity-sandbox-toolkit/agent-seed/bin/git',
  );
  expect(readFileSync(shipped, 'utf8')).toBe(readFileSync(WRAPPER, 'utf8'));
});

describe('agent-seed/bin/git guard (self-remove of session worktree)', () => {
  it('is transparent for non-worktree commands (status)', async () => {
    const { code } = await runWrapper(['status', '--short', '--branch'], main);
    expect(code).toBe(0);
  });

  it('is transparent for worktree subcommands other than remove (list)', async () => {
    const { code, stdout } = await runWrapper(['worktree', 'list'], main);
    expect(code).toBe(0);
    expect(stdout).toContain('.verity-sessions/agent-test');
  });

  it('blocks removing a session worktree by path from the main repo', async () => {
    const { code, stderr } = await runWrapper(
      ['worktree', 'remove', '.verity-sessions/agent-test'],
      main,
    );
    expect(code).toBe(1);
    expect(stderr).toContain('refusing');
    expect(stderr).toContain('.verity-sessions/agent-test');
    // The worktree must still exist — it was never removed.
    expect(existsSync(join(main, '.verity-sessions/agent-test'))).toBe(true);
  });

  it('blocks self-removal from inside the session worktree (absolute path)', async () => {
    const worktree = join(main, '.verity-sessions/agent-test');
    const { code, stderr } = await runWrapper(['worktree', 'remove', worktree], worktree);
    expect(code).toBe(1);
    expect(stderr).toContain('refusing');
    expect(existsSync(worktree)).toBe(true);
  });

  it('blocks even with --force and global options before the subcommand', async () => {
    const { code } = await runWrapper(
      ['-C', main, 'worktree', 'remove', '--force', '.verity-sessions/agent-test'],
      base,
    );
    expect(code).toBe(1);
    expect(existsSync(join(main, '.verity-sessions/agent-test'))).toBe(true);
  });

  it.each(['prune', 'unlock', 'move', 'repair'])(
    'blocks shared worktree administration: %s',
    async (action) => {
      const { code, stderr } = await runWrapper(['-C', main, 'worktree', action], base);
      expect(code).toBe(1);
      expect(stderr).toContain('verity git guard: refusing');
    },
  );

  it('preserves an invisible live session index when prune is requested', async () => {
    const admin = join(main, '.git', 'worktrees', 'agent-test');
    writeFileSync(join(admin, 'gitdir'), '/invisible-host/session/.git\n');
    const { code } = await runWrapper(['worktree', 'prune', '--expire', 'now'], main);
    expect(code).toBe(1);
    expect(existsSync(join(admin, 'index'))).toBe(true);
    // Verify the fixture exposes the incident instead of relying on Git expiry defaults.
    await realGit(main, 'worktree', 'prune', '--expire', 'now');
    expect(existsSync(admin)).toBe(false);
  });

  it('allows removing a normal (non-session) worktree', async () => {
    expect(existsSync(join(main, 'sidetree'))).toBe(true);
    const { code } = await runWrapper(['worktree', 'remove', 'sidetree'], main);
    expect(code).toBe(0);
    expect(existsSync(join(main, 'sidetree'))).toBe(false);
  });

  it('delegates to real git (does not block) when no target path is given', async () => {
    // `git worktree remove` with no path is a usage error — real git must report
    // it, and the guard must not emit its own refusal.
    const { code, stderr } = await runWrapper(['worktree', 'remove'], main);
    expect(code).not.toBe(0);
    expect(stderr).not.toContain('verity git guard');
  });

  it('is fully transparent when VERITY_GIT_GUARD_DISABLE=1 (escape hatch)', async () => {
    const { code } = await runWrapper(
      ['worktree', 'remove', '--force', '.verity-sessions/agent-test'],
      main,
      { VERITY_GIT_GUARD_DISABLE: '1' },
    );
    expect(code).toBe(0);
    expect(existsSync(join(main, '.verity-sessions/agent-test'))).toBe(false);
  });
});

/**
 * The pre-push gate offers a way through every block it raises, so for an
 * agent `--no-verify` is never the next step — and a `core.hooksPath` given on
 * the command line is the same bypass by another spelling. Only `push` is
 * guarded: `git commit --no-verify` is a local act the push scan catches again.
 */
describe('agent-seed/bin/git guard (push bypass)', () => {
  let remote: string;

  beforeEach(async () => {
    remote = join(base, 'remote.git');
    mkdirSync(remote);
    await realGit(remote, 'init', '-q', '--bare');
    await realGit(main, 'remote', 'add', 'origin', remote);
  });

  it('refuses git push --no-verify and names the gate commands instead', async () => {
    const { code, stderr } = await runWrapper(
      ['push', '--no-verify', 'origin', 'HEAD:refs/heads/x'],
      main,
    );
    expect(code).toBe(1);
    expect(stderr).toContain("refusing 'git push --no-verify'");
    expect(stderr).toContain('verity-code-review run');
    expect(stderr).toContain('verity-local-checks skip');
    // Nothing reached the remote.
    const { stdout } = await execFileAsync(REAL_GIT, ['-C', remote, 'branch', '--list'], {
      env: { ...process.env, ...GIT_ENV },
    });
    expect(stdout.trim()).toBe('');
  });

  it.each(['--no-veri', '--no-verif'])(
    'refuses the abbreviation %s, which git accepts for --no-verify',
    async (flag) => {
      const { code, stderr } = await runWrapper(
        ['push', flag, 'origin', 'HEAD:refs/heads/x'],
        main,
      );
      expect(code).toBe(1);
      expect(stderr).toContain('verity git guard');
    },
  );

  it('does not mistake --no-verbose for --no-verify', async () => {
    const { code, stderr } = await runWrapper(
      ['push', '--no-verbose', '--dry-run', 'origin', 'HEAD:refs/heads/x'],
      main,
    );
    expect(code).toBe(0);
    expect(stderr).not.toContain('verity git guard');
  });

  it.each([
    [['-c', 'core.hooksPath=/dev/null', 'push', 'origin', 'HEAD:refs/heads/x']],
    [['--config-env=core.hookspath=HOOKS', 'push', 'origin', 'HEAD:refs/heads/x']],
  ])('refuses a push with a hooksPath override: %j', async (args) => {
    const { code, stderr } = await runWrapper(args, main, { HOOKS: '/dev/null' });
    expect(code).toBe(1);
    expect(stderr).toContain('core.hooksPath override');
  });

  it.each([
    [{ GIT_CONFIG_PARAMETERS: "'core.hooksPath=/dev/null'" }],
    [
      {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.HooksPath',
        GIT_CONFIG_VALUE_0: '/dev/null',
      },
    ],
  ])('refuses a push whose hooksPath override arrives via the environment: %j', async (env) => {
    const { code, stderr } = await runWrapper(['push', 'origin', 'HEAD:refs/heads/x'], main, env);
    expect(code).toBe(1);
    expect(stderr).toContain('core.hooksPath override');
  });

  it('leaves a push alone when the environment carries only other keys', async () => {
    // The signing broker hands git its gpg.* settings this way; a guard that
    // fired on any GIT_CONFIG_* would refuse every signed push.
    const { code, stderr } = await runWrapper(
      ['push', '--dry-run', 'origin', 'HEAD:refs/heads/x'],
      main,
      { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'gpg.format', GIT_CONFIG_VALUE_0: 'ssh' },
    );
    expect(code).toBe(0);
    expect(stderr).not.toContain('verity git guard');
  });

  it('lets a dry run and an unrelated -c through', async () => {
    const { code, stderr } = await runWrapper(
      ['-c', 'user.name=t', 'push', '--dry-run', 'origin', 'HEAD:refs/heads/x'],
      main,
    );
    expect(code).toBe(0);
    expect(stderr).not.toContain('verity git guard');
  });

  it('treats --no-verify after -- as a refspec, not a flag', async () => {
    // Real git rejects the refspec; the point is that the guard did not fire.
    const { stderr } = await runWrapper(['push', '--dry-run', 'origin', '--', '--no-verify'], main);
    expect(stderr).not.toContain('verity git guard');
  });

  it('leaves --no-verify on other subcommands alone', async () => {
    const { code } = await runWrapper(
      ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '--allow-empty', '-q', '-m', 'x'],
      main,
    );
    expect(code).toBe(0);
  });

  it('is transparent with VERITY_GIT_GUARD_DISABLE=1 (operator escape hatch)', async () => {
    const { code, stderr } = await runWrapper(
      ['push', '--no-verify', '--dry-run', 'origin', 'HEAD:refs/heads/x'],
      main,
      { VERITY_GIT_GUARD_DISABLE: '1' },
    );
    expect(code).toBe(0);
    expect(stderr).not.toContain('verity git guard');
  });
});

describe('agent-seed/bin/git (re-signing on push)', () => {
  let remote: string;
  const developer = {
    VERITY_TURN_CAPABILITY: 'a'.repeat(43),
    GIT_AUTHOR_NAME: 'Dev',
    GIT_AUTHOR_EMAIL: 'dev@example.com',
    GIT_COMMITTER_NAME: 'Dev',
    GIT_COMMITTER_EMAIL: 'dev@example.com',
  };
  const member = {
    GIT_AUTHOR_NAME: 'Mia',
    GIT_AUTHOR_EMAIL: 'mia@users.verity.invalid',
    GIT_COMMITTER_NAME: 'Mia',
    GIT_COMMITTER_EMAIL: 'mia@users.verity.invalid',
  };

  /** Real git with the repository's own (signing) config, as a given person. */
  async function gitAs(env: NodeJS.ProcessEnv, ...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(REAL_GIT, args, {
      cwd: main,
      env: { ...process.env, ...GIT_ENV, ...env },
    });
    return stdout.trim();
  }
  const show = (format: string, rev = 'HEAD') => gitAs({}, 'log', '-1', `--format=${format}`, rev);
  const signed = async (rev: string) =>
    (await gitAs({}, 'cat-file', 'commit', rev)).split('\n\n')[0]!.includes('gpgsig');
  async function commitAs(env: NodeJS.ProcessEnv, file: string, content: string, sign: boolean) {
    writeFileSync(join(main, file), content);
    await gitAs(env, 'add', file);
    await gitAs(
      env,
      '-c',
      `commit.gpgsign=${String(sign)}`,
      'commit',
      '-q',
      '-m',
      `${file}=${content}`,
    );
    return gitAs({}, 'rev-parse', 'HEAD');
  }

  beforeEach(async () => {
    remote = join(base, 'remote.git');
    mkdirSync(remote);
    await realGit(remote, 'init', '-q', '--bare');
    await realGit(main, 'remote', 'add', 'origin', remote);
    await realGit(main, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    await realGit(main, 'fetch', '-q', 'origin');
    // A stand-in for verity-git-sign: any recognizable SSH signature will do.
    const signer = join(base, 'fake-sign');
    writeFileSync(
      signer,
      '#!/bin/sh\nfor last; do :; done\nprintf -- "-----BEGIN SSH SIGNATURE-----\\nZmFrZQ==\\n-----END SSH SIGNATURE-----\\n" > "$last.sig"\n',
      { mode: 0o755 },
    );
    writeFileSync(join(base, 'key.pub'), 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKey dev\n');
    for (const [key, value] of [
      ['gpg.format', 'ssh'],
      ['gpg.ssh.program', signer],
      ['user.signingkey', join(base, 'key.pub')],
      ['commit.gpgsign', 'true'],
    ])
      await realGit(main, 'config', key!, value!);
  });

  // The ADR's vouching: the member stays the author, the pushing developer
  // becomes committer and signer, and earlier signed work keeps its hash.
  it("re-signs a member's commits as the pushing developer and keeps everything else", async () => {
    const signedByOther = await commitAs(developer, 'b.txt', 'dev', true);
    const memberCommit = await commitAs(member, 'c.txt', 'mia', false);
    mkdirSync(join(main, '.agents'));
    writeFileSync(join(main, '.agents/.last-code-review-sha'), `${memberCommit}\n`);
    writeFileSync(join(main, 'a.txt'), 'uncommitted');

    const { code, stderr } = await runWrapper(
      ['push', '-q', 'origin', 'HEAD:refs/heads/main'],
      main,
      developer,
    );

    expect(code).toBe(0);
    expect(stderr).toContain('re-signed 1 commit(s) by Mia with your key');
    const head = await gitAs({}, 'rev-parse', 'HEAD');
    expect(head).not.toBe(memberCommit);
    expect(await show('%an <%ae>|%cn <%ce>')).toBe(
      'Mia <mia@users.verity.invalid>|Dev <dev@example.com>',
    );
    expect(await signed('HEAD')).toBe(true);
    expect(await gitAs({}, 'rev-parse', 'HEAD^')).toBe(signedByOther);
    expect(await gitAs({}, '--git-dir', remote, 'rev-parse', 'main')).toBe(head);
    expect(readFileSync(join(main, '.agents/.last-code-review-sha'), 'utf8').trim()).toBe(head);
    expect(readFileSync(join(main, 'a.txt'), 'utf8')).toBe('uncommitted');
  });

  // Only a push of the checked-out branch may rewrite it: a dry run, a deletion
  // or a push of another ref must leave HEAD exactly as it is.
  it('leaves HEAD alone on a dry run, a deletion and a push of another ref', async () => {
    const memberCommit = await commitAs(member, 'c.txt', 'mia', false);
    await gitAs({}, 'branch', 'other');
    for (const args of [
      ['push', '--dry-run', 'origin', 'HEAD:refs/heads/main'],
      ['push', 'origin', '--delete', 'nothing-here'],
      ['push', 'origin', 'other:refs/heads/other'],
    ]) {
      await runWrapper(args, main, developer);
      expect(await gitAs({}, 'rev-parse', 'HEAD'), args.join(' ')).toBe(memberCommit);
    }
  });

  // A commit merged in from the remote is already published; rewriting the
  // range around it would give it a new hash that diverges from everyone's.
  it('does not rewrite a range that holds a published commit', async () => {
    const memberCommit = await commitAs(member, 'c.txt', 'mia', false);
    // Someone else publishes to main, which is then merged into this branch.
    const start = await gitAs({}, 'rev-parse', 'HEAD');
    await gitAs({}, 'checkout', '-q', '-b', 'upstream', 'origin/main');
    await commitAs(developer, 'u.txt', 'up', true);
    await gitAs({}, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    await gitAs({}, 'fetch', '-q', 'origin');
    const published = await gitAs({}, 'rev-parse', 'HEAD');
    await gitAs({}, 'checkout', '-q', '-');
    expect(await gitAs({}, 'rev-parse', 'HEAD')).toBe(start);
    await gitAs(developer, '-c', 'commit.gpgsign=true', 'merge', '-q', '--no-edit', 'upstream');
    const before = await gitAs({}, 'rev-parse', 'HEAD');

    const { stderr } = await runWrapper(
      ['push', 'origin', 'HEAD:refs/heads/side'],
      main,
      developer,
    );
    expect(stderr).toContain('not re-signing: published commits');
    expect(await gitAs({}, 'rev-parse', 'HEAD')).toBe(before);
    expect(await gitAs({}, 'merge-base', '--is-ancestor', published, 'HEAD').then(() => true)).toBe(
      true,
    );
    expect(memberCommit).not.toBe(before);
  });

  it('keeps merge commits when it re-signs them', async () => {
    const start = await gitAs({}, 'rev-parse', 'HEAD');
    await gitAs({}, 'checkout', '-q', '-b', 'side');
    await commitAs(member, 'side.txt', 'side', false);
    await gitAs({}, 'checkout', '-q', '-');
    await commitAs(member, 'c.txt', 'mia', false);
    await gitAs(
      member,
      '-c',
      'commit.gpgsign=false',
      'merge',
      '-q',
      '--no-ff',
      '-m',
      'merge side',
      'side',
    );

    const { code } = await runWrapper(
      ['push', '-q', 'origin', 'HEAD:refs/heads/main'],
      main,
      developer,
    );

    expect(code).toBe(0);
    expect((await show('%p')).split(' ')).toHaveLength(2);
    for (const rev of (await gitAs({}, 'rev-list', `${start}..HEAD`)).split('\n'))
      expect(await signed(rev)).toBe(true);
  });

  // A replay that cannot complete must leave nothing half-done: same branch,
  // same worktree, nothing on the remote.
  it('refuses the push and changes nothing when the replay cannot complete', async () => {
    writeFileSync(join(main, 'm.txt'), 'base');
    await gitAs(member, '-c', 'commit.gpgsign=false', 'add', 'm.txt');
    await gitAs(member, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base');
    await gitAs({}, 'checkout', '-q', '-b', 'side');
    await commitAs(member, 'm.txt', 'side', false);
    await gitAs({}, 'checkout', '-q', '-');
    await commitAs(member, 'm.txt', 'main', false);
    await gitAs(member, '-c', 'commit.gpgsign=false', 'merge', '-q', 'side').catch(() => undefined);
    writeFileSync(join(main, 'm.txt'), 'resolved');
    await gitAs(member, 'add', 'm.txt');
    await gitAs(member, '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-edit');
    const before = await gitAs({}, 'rev-parse', 'HEAD');
    const remoteBefore = await gitAs({}, '--git-dir', remote, 'rev-parse', 'main');
    const statusBefore = await gitAs({}, 'status', '--porcelain');

    const { code, stderr } = await runWrapper(
      ['push', '-q', 'origin', 'HEAD:refs/heads/main'],
      main,
      developer,
    );

    expect(code).toBe(1);
    expect(stderr).toContain('refusing to push unsigned commits by: Mia');
    expect(await gitAs({}, 'rev-parse', 'HEAD')).toBe(before);
    expect(await gitAs({}, 'status', '--porcelain')).toBe(statusBefore);
    expect(await gitAs({}, '--git-dir', remote, 'rev-parse', 'main')).toBe(remoteBefore);
  });

  it('leaves a push without a person untouched', async () => {
    const memberCommit = await commitAs(member, 'c.txt', 'mia', false);
    const { code, stderr } = await runWrapper(
      ['push', '-q', 'origin', 'HEAD:refs/heads/main'],
      main,
      {
        GIT_COMMITTER_EMAIL: 'dev@example.com',
      },
    );
    expect(code).toBe(0);
    expect(stderr).not.toContain('re-signed');
    expect(await gitAs({}, 'rev-parse', 'HEAD')).toBe(memberCommit);
  });
});

describe('agent-seed/bin/git guard (core.worktree in the shared repository config)', () => {
  const sharedConfig = (): string => join(main, '.git', 'config');
  const session = (): string => join(main, '.verity-sessions', 'agent-test');
  /** GIT_DIR as git exports it to a hook running in the session worktree. */
  const hookGitDir = (): string => join(main, '.git', 'worktrees', 'agent-test');

  it('refuses git init that re-initializes the shared repository with a work tree', async () => {
    // The reproduced writer: a hook's inherited GIT_DIR plus a work tree. Real git records
    // the session as core.worktree in the config every session shares.
    const before = readFileSync(sharedConfig(), 'utf8');
    const { code, stderr } = await runWrapper(['init', '-q'], session(), {
      GIT_DIR: hookGitDir(),
      GIT_WORK_TREE: session(),
    });
    expect(code).toBe(1);
    expect(stderr).toContain('verity git guard: refusing');
    expect(readFileSync(sharedConfig(), 'utf8')).toBe(before);
  });

  it('is what stands between that call and a re-pointed main checkout', async () => {
    // Same call through real git: the shared config gains the session as core.worktree.
    // If this ever stops writing the key, the refusal above guards nothing and can go.
    await execFileAsync(REAL_GIT, ['init', '-q'], {
      cwd: session(),
      env: { ...process.env, ...GIT_ENV, GIT_DIR: hookGitDir(), GIT_WORK_TREE: session() },
    });
    expect(readFileSync(sharedConfig(), 'utf8')).toMatch(/worktree = .*agent-test/);
  });

  it('refuses git init with only the hook GIT_DIR, which would make the repository bare', async () => {
    const before = readFileSync(sharedConfig(), 'utf8');
    const { code } = await runWrapper(['init', '-q'], session(), { GIT_DIR: hookGitDir() });
    expect(code).toBe(1);
    expect(readFileSync(sharedConfig(), 'utf8')).toBe(before);
    // Real git, same call: the shared repository turns bare under every session.
    await execFileAsync(REAL_GIT, ['init', '-q'], {
      cwd: session(),
      env: { ...process.env, ...GIT_ENV, GIT_DIR: hookGitDir() },
    });
    expect(readFileSync(sharedConfig(), 'utf8')).toMatch(/bare = true/);
  });

  it('refuses the --git-dir / --work-tree option spelling as well', async () => {
    const { code } = await runWrapper(
      [`--git-dir=${hookGitDir()}`, '--work-tree', session(), 'init', '-q'],
      session(),
    );
    expect(code).toBe(1);
  });

  it('follows the gitfile of a session worktree to the shared repository', async () => {
    const before = readFileSync(sharedConfig(), 'utf8');
    const { code } = await runWrapper(['init', '-q'], session(), {
      GIT_DIR: join(session(), '.git'),
      GIT_WORK_TREE: session(),
    });
    expect(code).toBe(1);
    expect(readFileSync(sharedConfig(), 'utf8')).toBe(before);
  });

  it('resolves a relative GIT_DIR inside the directory git init creates', async () => {
    // A hook in the main checkout carries GIT_DIR=.git; `git init <dir>` reads it from <dir>.
    const fixture = join(base, 'fixture');
    const { code } = await runWrapper(['init', '-q', fixture], main, { GIT_DIR: '.git' });
    expect(code).toBe(0);
    expect(existsSync(join(fixture, '.git', 'HEAD'))).toBe(true);
    expect((await runWrapper(['init', '-q'], main, { GIT_DIR: '.git' })).code).toBe(1);
  });

  it('needs no rule for a work tree alone: git itself refuses init without a git dir', async () => {
    // Why the wrapper only inspects GIT_DIR / --git-dir. Should git ever accept this, the
    // session's gitfile would lead it into the shared repository and this has to change.
    const before = readFileSync(sharedConfig(), 'utf8');
    await expect(
      execFileAsync(REAL_GIT, ['init', '-q'], {
        cwd: session(),
        env: { ...process.env, ...GIT_ENV, GIT_WORK_TREE: join(base, 'elsewhere') },
      }),
    ).rejects.toThrow(/not allowed without specifying GIT_DIR/);
    expect(readFileSync(sharedConfig(), 'utf8')).toBe(before);
  });

  it('still lets an unrelated existing repository be re-initialized', async () => {
    const cache = join(base, 'cache.git');
    await realGit(base, 'init', '-q', '--bare', cache);
    const { code } = await runWrapper([`--git-dir=${cache}`, 'init', '-q', '--bare'], base);
    expect(code).toBe(0);
  });

  it('still lets a separate repository be created with both set', async () => {
    const fresh = join(base, 'fresh');
    mkdirSync(fresh);
    const { code } = await runWrapper(['init', '-q'], base, {
      GIT_DIR: join(fresh, '.git'),
      GIT_WORK_TREE: fresh,
    });
    expect(code).toBe(0);
    expect(existsSync(join(fresh, '.git', 'HEAD'))).toBe(true);
  });

  it('refuses writing core.worktree into the shared config, whatever the case', async () => {
    for (const args of [
      ['config', 'core.worktree', '/work/.verity-sessions/agent-test'],
      ['config', '--local', 'Core.WorkTree', '/elsewhere'],
      ['config', 'set', 'core.worktree', '/elsewhere'],
      ['config', '--add', 'core.worktree', '/elsewhere'],
      ['config', '--type', 'path', 'core.worktree', '/elsewhere'],
      // Without extensions.worktreeConfig, --worktree writes the shared config like --local.
      ['config', '--worktree', 'core.worktree', '/elsewhere'],
    ]) {
      const { code, stderr } = await runWrapper(args, session());
      expect(code, args.join(' ')).toBe(1);
      expect(stderr).toContain("'git config core.worktree'");
    }
    expect(readFileSync(sharedConfig(), 'utf8')).not.toMatch(/worktree =/);
  });

  it('lets reads, removals and explicitly scoped writes through', async () => {
    await realGit(main, 'config', '--file', sharedConfig(), 'core.worktree', '/tmp/x');
    expect((await runWrapper(['config', '--get', 'core.worktree'], main)).stdout.trim()).toBe(
      '/tmp/x',
    );
    expect((await runWrapper(['config', '--unset', 'core.worktree'], main)).code).toBe(0);
    const other = join(base, 'other.cfg');
    expect((await runWrapper(['config', '--file', other, 'core.worktree', '/x'], main)).code).toBe(
      0,
    );
    expect((await runWrapper(['config', 'user.name', 'n'], session())).code).toBe(0);
    await realGit(main, 'config', '--file', sharedConfig(), 'core.worktree', '/tmp/y');
    // Bare and decorated reads are reads, whatever flags they carry.
    for (const args of [
      ['config', 'core.worktree'],
      ['config', '--show-origin', 'core.worktree'],
      ['config', '--type', 'path', 'core.worktree'],
      ['config', '--null', 'core.worktree'],
      ['config', 'get', 'core.worktree'],
    ]) {
      const { code, stderr } = await runWrapper(args, main);
      expect(stderr, args.join(' ')).not.toContain('verity git guard');
      expect(code, `${args.join(' ')}: ${stderr}`).not.toBe(1);
    }
  });

  it('is transparent with VERITY_GIT_GUARD_DISABLE=1 (operator escape hatch)', async () => {
    const { code } = await runWrapper(['config', 'core.worktree', main], main, {
      VERITY_GIT_GUARD_DISABLE: '1',
    });
    expect(code).toBe(0);
  });
});
