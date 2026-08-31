import { execFileSync, spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scan = fileURLToPath(new URL('../agent-seed/bin/verity-secret-scan', import.meta.url));
const preCommit = fileURLToPath(new URL('../agent-seed/hooks/pre-commit', import.meta.url));
const prePush = fileURLToPath(new URL('../agent-seed/hooks/pre-push', import.meta.url));

const tempRoots: string[] = [];

/** A git repo with one commit, so HEAD and merge-base resolve. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'verity-secret-scan-'));
  tempRoots.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  // These tests invoke the hooks directly, never through git, and one of them
  // has to COMMIT a credential to produce a range to scan. An agent sandbox
  // points global `core.hooksPath` at the installed agent-seed hooks, which the
  // fixture would otherwise inherit — its own pre-commit gitleaks gate then
  // blocks the deliberate leak and the test fails for the environment it runs
  // in, not for what it asserts. Give the fixture an empty hook directory so it
  // exercises plain git either way.
  execFileSync('git', ['-C', root, 'config', 'core.hooksPath', join(root, 'no-hooks')]);
  execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'test/secret-scan']);
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', root, 'add', 'README.md']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'base']);
  return root;
}

/**
 * A stub standing in for gitleaks or for verity-secret-scan itself: records the
 * argv it was called with, then exits with `status`. Keeps the tests independent
 * of whether a real gitleaks binary exists on the runner.
 */
function stub(root: string, name: string, status: number): { path: string; argv: () => string } {
  const path = join(root, name);
  const log = join(root, `${name}.argv`);
  writeFileSync(path, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "${log}"\nexit ${status}\n`);
  chmodSync(path, 0o755);
  return {
    path,
    argv: () => {
      try {
        return readFileSync(log, 'utf8');
      } catch {
        return '';
      }
    },
  };
}

function run(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(bin, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('verity-secret-scan', () => {
  it('blocks when the repository declares scanning but gitleaks is missing', () => {
    const root = repo();
    writeFileSync(join(root, '.gitleaksignore'), '# baseline\n');

    const result = run(scan, ['staged'], root, {
      VERITY_GITLEAKS_BIN: join(root, 'no-such-gitleaks'),
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('gitleaks is not installed');
  });

  it('stays inert in a repository that declares no gitleaks config', () => {
    const root = repo();

    const result = run(scan, ['staged'], root, {
      VERITY_GITLEAKS_BIN: join(root, 'no-such-gitleaks'),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('reports findings as exit 1 and a scanner failure as exit 2', () => {
    const root = repo();
    const found = stub(root, 'gitleaks-found', 3);
    const broken = stub(root, 'gitleaks-broken', 1);
    const clean = stub(root, 'gitleaks-clean', 0);

    expect(run(scan, ['staged'], root, { VERITY_GITLEAKS_BIN: found.path }).status).toBe(1);
    expect(run(scan, ['staged'], root, { VERITY_GITLEAKS_BIN: clean.path }).status).toBe(0);

    const failure = run(scan, ['staged'], root, { VERITY_GITLEAKS_BIN: broken.path });
    expect(failure.status).toBe(2);
    expect(failure.stderr).toContain('scan did not complete');
  });

  it('passes the staged flag, the commit range and the ignore path to gitleaks', () => {
    const root = repo();
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const staged = stub(root, 'gitleaks-staged', 0);
    const ranged = stub(root, 'gitleaks-range', 0);

    run(scan, ['staged'], root, { VERITY_GITLEAKS_BIN: staged.path });
    run(scan, ['range', head], root, { VERITY_GITLEAKS_BIN: ranged.path });

    expect(staged.argv()).toContain('--staged');
    expect(staged.argv()).toContain('--redact');
    expect(staged.argv()).toContain(`--gitleaks-ignore-path`);
    expect(ranged.argv()).toContain(`--log-opts=${head}..HEAD`);
    expect(ranged.argv()).not.toContain('--staged');
  });

  it('points gitleaks at a repository config under either supported name', () => {
    const dotted = repo();
    writeFileSync(join(dotted, '.gitleaks.toml'), 'title = "dotted"\n');
    const dottedStub = stub(dotted, 'gitleaks-dotted', 0);
    run(scan, ['staged'], dotted, { VERITY_GITLEAKS_BIN: dottedStub.path });
    expect(dottedStub.argv()).toContain(join(dotted, '.gitleaks.toml'));

    // The undotted name is the one gitleaks does NOT auto-load from the target.
    const plain = repo();
    writeFileSync(join(plain, 'gitleaks.toml'), 'title = "plain"\n');
    const plainStub = stub(plain, 'gitleaks-plain', 0);
    run(scan, ['staged'], plain, { VERITY_GITLEAKS_BIN: plainStub.path });
    expect(plainStub.argv().split('\n')).toContain('--config');
    expect(plainStub.argv()).toContain(join(plain, 'gitleaks.toml'));
  });

  it('leaves an explicit GITLEAKS_CONFIG override in charge', () => {
    const root = repo();
    writeFileSync(join(root, '.gitleaks.toml'), 'title = "repo"\n');
    const clean = stub(root, 'gitleaks-clean', 0);

    run(scan, ['staged'], root, {
      VERITY_GITLEAKS_BIN: clean.path,
      GITLEAKS_CONFIG: join(root, 'elsewhere.toml'),
    });

    expect(clean.argv().split('\n')).not.toContain('--config');
  });

  it('rejects an unknown mode and a range without a base', () => {
    const root = repo();
    const clean = stub(root, 'gitleaks-clean', 0);

    expect(run(scan, ['everything'], root, { VERITY_GITLEAKS_BIN: clean.path }).status).toBe(2);
    expect(run(scan, ['range'], root, { VERITY_GITLEAKS_BIN: clean.path }).status).toBe(2);
  });
});

describe('pre-commit secret gate', () => {
  it('blocks the commit when the scan reports a finding', () => {
    const root = repo();
    const finding = stub(root, 'scan-finding', 1);

    const result = run(preCommit, [], root, { VERITY_SECRET_SCAN_BIN: finding.path });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('COMMIT BLOCKED - secret detected');
    expect(finding.argv()).toContain('staged');
  });

  it('blocks the commit when the scan cannot run', () => {
    const root = repo();
    const unusable = stub(root, 'scan-unusable', 2);

    const result = run(preCommit, [], root, { VERITY_SECRET_SCAN_BIN: unusable.path });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('COMMIT BLOCKED - secret scan could not run');
  });

  it('blocks the commit when the helper is missing', () => {
    const root = repo();

    const result = run(preCommit, [], root, {
      VERITY_SECRET_SCAN_BIN: join(root, 'no-such-helper'),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('secret scan helper missing');
  });

  it('resolves the sibling helper without coreutils on PATH', () => {
    const root = repo();
    const bin = join(root, 'minimal-path');
    mkdirSync(bin);
    for (const command of ['env', 'bash', 'git']) {
      const source = execFileSync('/usr/bin/env', ['sh', '-c', `command -v ${command}`], {
        encoding: 'utf8',
      }).trim();
      symlinkSync(source, join(bin, command));
    }

    // No VERITY_SECRET_SCAN_BIN: the hook must find agent-seed/bin/verity-secret-scan
    // relative to itself using shell builtins only (no dirname, no basename).
    const result = run(preCommit, [], root, { PATH: bin });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('secret scan helper missing');
  });

  it('allows a clean commit', () => {
    const root = repo();
    const clean = stub(root, 'scan-clean', 0);

    const result = run(preCommit, [], root, { VERITY_SECRET_SCAN_BIN: clean.path });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});

describe('pre-push secret gate', () => {
  it('blocks the push on a finding, before the lint gate can mask it', () => {
    const root = repo();
    // A lint script with no node_modules is what the lint gate blocks on; the
    // secret finding must still be the reported reason.
    writeFileSync(join(root, 'package.json'), '{"scripts":{"lint":"eslint ."}}');
    const finding = stub(root, 'scan-finding', 1);

    const result = run(prePush, [], root, { VERITY_SECRET_SCAN_BIN: finding.path });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('PUSH BLOCKED - secret detected');
    expect(result.stderr).not.toContain('lint/format toolchain unavailable');
  });

  it('blocks the push when the scan cannot run', () => {
    const root = repo();
    const unusable = stub(root, 'scan-unusable', 2);

    const result = run(prePush, [], root, { VERITY_SECRET_SCAN_BIN: unusable.path });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('PUSH BLOCKED - secret scan could not run');
  });

  it('blocks the push when the helper is missing', () => {
    const root = repo();

    const result = run(prePush, [], root, {
      VERITY_SECRET_SCAN_BIN: join(root, 'no-such-helper'),
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('secret scan helper missing');
  });

  it('scans the branch range against the review base', () => {
    const root = repo();
    const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['-C', root, 'branch', 'review-base', base]);
    writeFileSync(join(root, 'feature.txt'), 'work\n');
    execFileSync('git', ['-C', root, 'add', 'feature.txt']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'feature']);
    const clean = stub(root, 'scan-clean', 0);

    run(prePush, [], root, {
      VERITY_SECRET_SCAN_BIN: clean.path,
      VERITY_CODE_REVIEW_BASE_REF: 'review-base',
    });

    expect(clean.argv().split('\n')).toContain('range');
    expect(clean.argv()).toContain(base);
  });

  it('falls back to the full history when no base ref resolves', () => {
    const root = repo();
    const clean = stub(root, 'scan-clean', 0);

    const result = run(prePush, [], root, {
      VERITY_SECRET_SCAN_BIN: clean.path,
      VERITY_CODE_REVIEW_BASE_REF: 'origin/does-not-exist',
    });

    expect(clean.argv().split('\n')).toContain('history');
    expect(result.stderr).toContain('scanning full history for secrets');
  });

  it('still scans on protected branches, where only the review gate is skipped', () => {
    const root = repo();
    execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'main']);
    const finding = stub(root, 'scan-finding', 1);

    const result = run(prePush, [], root, { VERITY_SECRET_SCAN_BIN: finding.path });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('PUSH BLOCKED - secret detected');
    expect(finding.argv()).not.toBe('');
  });

  it('lets a clean push through on a protected branch without reaching the review gate', () => {
    const root = repo();
    execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'main']);
    const clean = stub(root, 'scan-clean', 0);

    const result = run(prePush, [], root, { VERITY_SECRET_SCAN_BIN: clean.path });

    expect(result.status).toBe(0);
    expect(clean.argv()).not.toBe('');
    expect(result.stderr).not.toContain('code review');
  });
});

describe('pre-push ref handling', () => {
  /** Feed the hook the "<local ref> <local sha> <remote ref> <remote sha>" lines git sends. */
  function push(root: string, refLines: string, env: NodeJS.ProcessEnv = {}) {
    return spawnSync(prePush, ['origin', 'git@example.invalid:x/y.git'], {
      cwd: root,
      encoding: 'utf8',
      input: refLines,
      env: { ...process.env, ...env },
    });
  }

  const zero = '0'.repeat(40);

  function commit(root: string, file: string, message: string): string {
    writeFileSync(join(root, file), `${message}\n`);
    execFileSync('git', ['-C', root, 'add', file]);
    execFileSync('git', ['-C', root, 'commit', '-qm', message]);
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  }

  it('scans the ref being pushed even when it is not the checked-out branch', () => {
    const root = repo();
    const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const other = commit(root, 'other.txt', 'other');
    execFileSync('git', ['-C', root, 'branch', 'other', other]);
    execFileSync('git', ['-C', root, 'reset', '-q', '--hard', base]);
    const clean = stub(root, 'scan-clean', 0);

    push(root, `refs/heads/other ${other} refs/heads/other ${zero}\n`, {
      VERITY_SECRET_SCAN_BIN: clean.path,
      VERITY_CODE_REVIEW_BASE_REF: 'HEAD',
    });

    // The pushed tip, not HEAD, is what gitleaks is pointed at.
    expect(clean.argv()).toContain(other);
  });

  it('uses the remote sha as the base when the remote already has it', () => {
    const root = repo();
    const remoteHas = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const tip = commit(root, 'feature.txt', 'feature');
    const clean = stub(root, 'scan-clean', 0);

    push(root, `refs/heads/test/secret-scan ${tip} refs/heads/test/secret-scan ${remoteHas}\n`, {
      VERITY_SECRET_SCAN_BIN: clean.path,
    });

    const argv = clean.argv().split('\n');
    expect(argv).toContain('range');
    expect(argv).toContain(remoteHas);
    expect(argv).toContain(tip);
  });

  it('scans every pushed tip', () => {
    const root = repo();
    const first = commit(root, 'a.txt', 'a');
    const second = commit(root, 'b.txt', 'b');
    const clean = stub(root, 'scan-clean', 0);

    push(
      root,
      `refs/heads/a ${first} refs/heads/a ${zero}\nrefs/heads/b ${second} refs/heads/b ${zero}\n`,
      {
        VERITY_SECRET_SCAN_BIN: clean.path,
        VERITY_CODE_REVIEW_BASE_REF: 'origin/does-not-exist',
      },
    );

    expect(clean.argv()).toContain(first);
    expect(clean.argv()).toContain(second);
  });

  it('does not scan a branch deletion', () => {
    const root = repo();
    const remoteHas = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const finding = stub(root, 'scan-finding', 1);

    const result = push(root, `(delete) ${zero} refs/heads/gone ${remoteHas}\n`, {
      VERITY_SECRET_SCAN_BIN: finding.path,
    });

    expect(finding.argv()).toBe('');
    expect(result.stderr).not.toContain('PUSH BLOCKED - secret detected');
  });
});

/**
 * The stubs above prove the plumbing; they cannot prove the pinned scanner still
 * detects anything. These run against the real binary wherever one exists (the
 * sandbox image ships it), and skip on a runner without it rather than failing.
 */
function findGitleaks(): string | undefined {
  const explicit = process.env.VERITY_GITLEAKS_BIN;
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  const found = spawnSync('sh', ['-c', 'command -v gitleaks'], { encoding: 'utf8' });
  const path = found.stdout.trim();
  return found.status === 0 && path ? path : undefined;
}

const gitleaks = findGitleaks();

describe.skipIf(!gitleaks)('verity-secret-scan against the real gitleaks binary', () => {
  /**
   * A GitHub PAT shaped like the real thing, generated per run: a literal in the
   * source would itself be a finding, in this repo's own scans and in every
   * downstream mirror of it.
   */
  function token(): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let body = '';
    for (let i = 0; i < 36; i += 1) body += alphabet[randomInt(alphabet.length)];
    return `ghp_${body}`;
  }

  const env = { VERITY_GITLEAKS_BIN: gitleaks ?? 'gitleaks' };

  it('detects a staged credential and reports it redacted', () => {
    const root = repo();
    const secret = token();
    writeFileSync(join(root, 'config.env'), `GITHUB_TOKEN=${secret}\n`);
    execFileSync('git', ['-C', root, 'add', 'config.env']);

    const result = run(scan, ['staged'], root, env);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('github-pat');
    // --redact: the value must never reach the hook output, and therefore never
    // the agent transcript.
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).toContain('Fingerprint:');
  });

  it('passes a clean staged diff', () => {
    const root = repo();
    writeFileSync(join(root, 'notes.md'), '# nothing secret here\n');
    execFileSync('git', ['-C', root, 'add', 'notes.md']);

    const result = run(scan, ['staged'], root, env);

    expect(result.status).toBe(0);
  });

  it('detects a credential in a commit range and honors the reported fingerprint', () => {
    const root = repo();
    const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    writeFileSync(join(root, 'config.env'), `GITHUB_TOKEN=${token()}\n`);
    execFileSync('git', ['-C', root, 'add', 'config.env']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'leak']);

    const blocked = run(scan, ['range', base], root, env);
    expect(blocked.status).toBe(1);

    const fingerprint = /Fingerprint:\s*(\S+)/.exec(blocked.stderr as string)?.[1];
    expect(fingerprint).toBeTruthy();

    // --gitleaks-ignore-path points at the repo root, so a baseline entry there
    // is what clears a known false positive — the same file CI reads.
    writeFileSync(join(root, '.gitleaksignore'), `${fingerprint}\n`);
    expect(run(scan, ['range', base], root, env).status).toBe(0);
  });
});
