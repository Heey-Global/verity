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
