// Imported by source path, not as `@verity/events`, the way every other test in
// this directory reaches across packages. `scripts/` is outside the workspace
// packages, so the bare specifier resolves through `node_modules` to the
// package's `dist/` — which the lint job never builds, leaving the type
// unresolved — and in a session worktree that symlink points at the main
// checkout rather than at the tree under test.
import { CODE_REVIEW_SYSTEM_PROMPT } from '../packages/events/src/code-review.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const seedHookPath = 'agent-seed/hooks/pre-push';
const shippedHookPath = 'features/verity-sandbox-toolkit/agent-seed/hooks/pre-push';
const hook = fileURLToPath(new URL(`../${seedHookPath}`, import.meta.url));
const shippedHook = fileURLToPath(new URL(`../${shippedHookPath}`, import.meta.url));
const tempRoots: string[] = [];

/**
 * Git in these fixtures must not inherit the sandbox's own configuration. A
 * global `core.hooksPath` (the installed seed hooks), `commit.gpgsign` (the
 * Verity signing broker) or `init.templateDir` would make the outcome depend on
 * the container rather than on the hook under test — and the seed `pre-commit`
 * in particular would drag gitleaks into a test about a pre-push message.
 */
const hermeticGit = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function git(args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    env: { ...process.env, ...hermeticGit },
  });
}

function emptyRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'verity-pre-push-'));
  tempRoots.push(repo);
  git(['init', '-q', repo]);
  git(['-C', repo, 'checkout', '-q', '-b', 'test/pre-push']);
  return repo;
}

function repoWith(packageJson: string): string {
  const repo = emptyRepo();
  writeFileSync(join(repo, 'package.json'), packageJson);
  return repo;
}

/** An empty commit on the current branch. An identity is required and there is no
 *  global config to take one from, so it is pinned here; signing and hook path are
 *  pinned as well, redundantly with {@link hermeticGit}, because a commit that
 *  reaches the signing broker or the seed hooks is the failure worth being loud
 *  about. */
function commit(repo: string, subject: string): string {
  git([
    '-C',
    repo,
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'user.name=Test',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    subject,
  ]);
  return git(['-C', repo, 'rev-parse', 'HEAD']).trim();
}

/** A stand-in for `verity-secret-scan` that passes everything, so a test about the
 *  review gate does not also need gitleaks on PATH. The hook takes this path from
 *  `VERITY_SECRET_SCAN_BIN` before any other resolution.
 *
 *  Kept in its own directory rather than inside the repository under test: the
 *  repository is the system under test, and an untracked file in its working tree
 *  is exactly the kind of state a future hook check could branch on. */
function passingSecretScan(): string {
  const dir = mkdtempSync(join(tmpdir(), 'verity-secret-scan-'));
  tempRoots.push(dir);
  const stub = join(dir, 'secret-scan-stub');
  writeFileSync(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return stub;
}

function runHook(
  cwd: string,
  opts: { path?: string; env?: Record<string, string>; input?: string } = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(hook, [], {
    cwd,
    encoding: 'utf8',
    input: opts.input,
    env: { ...process.env, ...hermeticGit, PATH: opts.path ?? process.env.PATH, ...opts.env },
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pre-push lint gate', () => {
  it('blocks a package repository when node is unavailable', () => {
    const repo = repoWith('{"scripts":{"lint":"eslint ."}}');
    const bin = join(repo, 'bin');
    mkdirSync(bin);
    for (const command of ['env', 'bash', 'git']) {
      const source = execFileSync('/usr/bin/env', ['sh', '-c', `command -v ${command}`], {
        encoding: 'utf8',
      }).trim();
      symlinkSync(source, join(bin, command));
    }

    const result = runHook(repo, { path: bin });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('package.json exists but node is unavailable');
  });

  it('blocks an invalid package.json', () => {
    const result = runHook(repoWith('{invalid'));

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('package.json is unreadable or invalid');
  });

  it('blocks declared checks when dependencies are unavailable', () => {
    const result = runHook(repoWith('{"scripts":{"lint":"eslint ."}}'));

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('local lint/format toolchain unavailable');
  });
});

/**
 * Both blocking messages have to name `verity-code-review run`, not only `mark`.
 *
 * This is the regression these tests exist for: the hook used to say "review the
 * branch diff with your active agent runtime" and then hand over `mark` — the one
 * command that satisfies the gate without reviewing anything. An agent that only
 * ever sees the block message reaches for what the block message names, so naming
 * `mark` alone is an instruction to turn the gate green on an unreviewed diff.
 */
describe('pre-push review gate message', () => {
  it('names run before mark when the review boundary is unusable', () => {
    const repo = emptyRepo();
    commit(repo, 'initial');

    const result = runHook(repo, {
      env: {
        VERITY_SECRET_SCAN_BIN: passingSecretScan(),
        // No such ref, and no marker file: the hook can resolve neither end of
        // the range and takes the "no usable code review boundary" branch.
        VERITY_CODE_REVIEW_BASE_REF: 'refs/heads/no-such-base',
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no usable code review boundary');
    // A fresh repo has no default base either, so reaching this branch proves
    // nothing on its own — the message has to name the ref we set, or the test
    // would stay green if the hook stopped reading the variable at all.
    expect(result.stderr).toContain('refs/heads/no-such-base');
    // `refs` is the leading component of that base but is not a remote. Printing
    // `git fetch --no-tags refs` here would hand the agent a command that fails,
    // on the one path where the message is all it has.
    expect(result.stderr).not.toMatch(/git fetch/);
    expect(result.stderr).toContain('is not a remote-tracking ref of any configured');
    // A bare `verity-code-review run` resolves this same base, so the only route
    // out of this branch is naming another one.
    expect(result.stderr).toContain('verity-code-review run <other-base-ref>');
    expect(result.stderr.indexOf('verity-code-review run')).toBeLessThan(
      result.stderr.indexOf('verity-code-review mark'),
    );
  });

  it.each([
    // All three spellings rev-parse to the same ref. Splitting the qualified
    // ones on their leading component yields `refs` or `remotes`, neither of
    // which is a remote — so without normalization a perfectly fetchable base
    // falls through to the no-remote dead end.
    ['a short remote-tracking base', 'upstream/main'],
    ['a fully qualified one', 'refs/remotes/upstream/main'],
    ['the refs-less middle spelling', 'remotes/upstream/main'],
  ])('names the actual remote to fetch from, given %s', (_label, baseRef) => {
    const repo = emptyRepo();
    commit(repo, 'initial');
    git(['-C', repo, 'remote', 'add', 'upstream', 'https://example.invalid/repo.git']);

    const result = runHook(repo, {
      env: {
        VERITY_SECRET_SCAN_BIN: passingSecretScan(),
        // A configured remote, but no such branch on it: same dead end, and the
        // one case where a concrete fetch command is worth printing.
        VERITY_CODE_REVIEW_BASE_REF: baseRef,
      },
    });

    expect(result.status).toBe(2);
    // Explicit destination refspec: a bare fetch would only populate FETCH_HEAD
    // on a remote configured without one, leaving the base still unresolvable
    // and the agent running the same command again. Forced, so a stale tracking
    // ref cannot turn the hint into a non-fast-forward failure.
    expect(result.stderr).toContain(
      'git fetch --no-tags upstream +refs/heads/main:refs/remotes/upstream/main',
    );
    // A configured remote is no promise that the branch exists on it, so this
    // hint can still fail with "couldn't find remote ref". Without the
    // other-base route printed here too, that failure has no exit.
    expect(result.stderr).toContain('verity-code-review run <other-base-ref>');
  });

  it('names run, rules out the improvised alternatives, and says mark verifies nothing', () => {
    const repo = emptyRepo();
    commit(repo, 'base');
    git(['-C', repo, 'branch', 'review-base']);
    const pending = commit(repo, 'un-reviewed work');

    const result = runHook(repo, {
      env: {
        VERITY_SECRET_SCAN_BIN: passingSecretScan(),
        VERITY_CODE_REVIEW_BASE_REF: 'review-base',
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('pre-push code review required');
    // Pin the branch. If VERITY_CODE_REVIEW_BASE_REF were ever ignored the hook
    // would fall through to the no-boundary message, which also prints HEAD — so
    // the SHA assertion below would still pass while this test quietly stopped
    // covering the un-reviewed-commits path it exists for.
    expect(result.stderr).not.toContain('no usable code review boundary');
    expect(result.stderr).toContain('Un-reviewed:');
    expect(result.stderr).toContain(pending);
    expect(result.stderr).toContain('verity-code-review run');
    expect(result.stderr.indexOf('verity-code-review run')).toBeLessThan(
      result.stderr.indexOf('verity-code-review mark'),
    );
    // The two ways an agent improvises around the gate, and the reason marking
    // early is not a shortcut but a defeat of the gate.
    expect(result.stderr).toContain('code_review');
    expect(result.stderr).toMatch(/not inline in the chat/i);
    expect(result.stderr).toMatch(/without verifying anything/i);
  });

  it('lets a marked HEAD through', () => {
    const repo = emptyRepo();
    commit(repo, 'base');
    git(['-C', repo, 'branch', 'review-base']);
    const head = commit(repo, 'reviewed work');
    mkdirSync(join(repo, '.agents'));
    writeFileSync(join(repo, '.agents/.last-code-review-sha'), `${head}\n`);

    const result = runHook(repo, {
      env: {
        VERITY_SECRET_SCAN_BIN: passingSecretScan(),
        VERITY_CODE_REVIEW_BASE_REF: 'review-base',
      },
    });

    expect(result.status).toBe(0);
    // Not just "exit 0": an early exit added anywhere before the marker check
    // would keep this green without the marker ever being consulted.
    expect(result.stderr).not.toContain('code review required');
  });

  it('reviews the local SHA being pushed rather than the checked-out HEAD', () => {
    const repo = emptyRepo();
    const base = commit(repo, 'base');
    git(['-C', repo, 'branch', 'review-base', base]);
    const pushed = commit(repo, 'work on other ref');
    git(['-C', repo, 'branch', 'other', pushed]);
    git(['-C', repo, 'reset', '--hard', base]);
    mkdirSync(join(repo, '.agents'));
    writeFileSync(join(repo, '.agents/.last-code-review-sha'), `${base}\n`);

    const result = runHook(repo, {
      input: `refs/heads/other ${pushed} refs/heads/other ${'0'.repeat(40)}\n`,
      env: {
        VERITY_SECRET_SCAN_BIN: passingSecretScan(),
        VERITY_CODE_REVIEW_BASE_REF: 'review-base',
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('pre-push code review required');
    expect(result.stderr).toContain(pushed);
  });
});

/**
 * The tests above execute `agent-seed/hooks/pre-push`, but the copy that reaches
 * a sandbox is the one inside the toolkit Feature, and what reaches it is what
 * git records — not what this checkout happens to look like.
 */
describe('agent-seed hook packaging', () => {
  it('ships the same hook, executable, in the toolkit Feature', () => {
    // Compared as text, not as Buffers: this is a check people will trip, and a
    // Buffer mismatch prints two hex dumps instead of the diverging line. CI's
    // `agent-seed-drift` job enforces the same thing, but only when those paths
    // change; here it fails in `npm test`, before the push.
    expect(readFileSync(shippedHook, 'utf8')).toBe(readFileSync(hook, 'utf8'));
    // Content is not the whole contract — a copy that arrives without the exec
    // bit passes the comparison above and then does nothing in a sandbox. Read
    // the mode git records rather than the mode on disk: the latter carries the
    // clone's umask, so a checkout under 0027 is 0750 and comparing all three
    // exec bits would fail on a hook that is perfectly executable.
    // Deliberately NOT through `git()`: this reads the real checkout, not a
    // fixture, and hermeticGit would discard the `safe.directory` exception a
    // container needs when the checkout belongs to another uid — git would abort
    // on dubious ownership rather than answer.
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    for (const path of [seedHookPath, shippedHookPath]) {
      const entry = execFileSync('git', ['-C', repoRoot, 'ls-files', '-s', '--', path], {
        encoding: 'utf8',
      });
      // An untracked path prints nothing, and slicing that would report an empty
      // string as a mode mismatch — "not 100755" rather than "not in the index".
      expect(entry, `${path} is not tracked`).not.toBe('');
      expect(entry.slice(0, 6)).toBe('100755');
    }
  });

  /**
   * AGENTS.md names five places that state the review contract. The two hook
   * copies are pinned to each other above, and each of the remaining artifacts
   * has its own test — but each only checks itself, so all of them could drift
   * together and stay green. This is the one assertion that compares two of them
   * directly: the hook a session reads when its push is blocked, and the prompt
   * fragment carried to sessions that never see the hook's text. `agent-seed/README.md`
   * is deliberately not in this loop — it addresses a human and names the
   * subcommands bare (`run`, `mark`), so holding it to the literal command
   * strings an agent needs would mean bending its prose to fit a check written
   * for a different audience.
   */
  it('says the same things as the shipped prompt fragment', () => {
    const text = readFileSync(hook, 'utf8');

    for (const artifact of [text, CODE_REVIEW_SYSTEM_PROMPT]) {
      expect(artifact).toContain('verity-code-review run');
      expect(artifact).toContain('verity-code-review mark');
      expect(artifact.indexOf('verity-code-review run')).toBeLessThan(
        artifact.indexOf('verity-code-review mark'),
      );
      expect(artifact).toContain('code_review');
    }
  });

  /**
   * The block message offers `verity-code-review run <other-base-ref>` as the way
   * out when the default base is unreachable. That is the one branch where the
   * message is all the agent has, so an argument form the CLI does not accept
   * would be worse than saying nothing — the same reasoning the adjacent
   * `FETCH_HINT` guard is built on. Pinned against the CLI's own usage text,
   * which is the contract both halves are written to.
   */
  it('offers an argument form the review CLI actually accepts', () => {
    const cli = fileURLToPath(new URL('../agent-seed/bin/verity-code-review', import.meta.url));

    expect(readFileSync(hook, 'utf8')).toContain('verity-code-review run <other-base-ref>');
    expect(readFileSync(cli, 'utf8')).toContain('verity-code-review run [base-ref]');
  });
});
