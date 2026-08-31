import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
