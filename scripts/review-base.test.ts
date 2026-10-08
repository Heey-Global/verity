import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const helper = fileURLToPath(new URL('../agent-seed/bin/verity-review-base.sh', import.meta.url));
const hook = fileURLToPath(new URL('../agent-seed/hooks/pre-push', import.meta.url));
const cli = fileURLToPath(new URL('../agent-seed/bin/verity-code-review', import.meta.url));
const env: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_COUNT: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const roots: string[] = [];
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim();
}
function fixture(distance = 2): { repo: string; base: string; upstream: string } {
  const root = mkdtempSync(join(tmpdir(), 'verity-review-base-'));
  roots.push(root);
  const upstream = join(root, 'upstream');
  mkdirSync(upstream);
  git(upstream, 'init', '-q', '-b', 'main');
  writeFileSync(
    join(upstream, 'package.json'),
    JSON.stringify({
      scripts: {
        lint: 'echo full-lint',
        'lint:changed': 'echo scoped-lint',
        format: 'echo full-format',
        'format:changed': 'echo scoped-format',
      },
    }),
  );
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-qm', 'base');
  const base = git(upstream, 'rev-parse', 'HEAD');
  git(upstream, 'checkout', '-qb', 'feature');
  // A single import keeps the beyond-budget fixture cheap even in containers
  // where invoking Git hundreds of times is expensive.
  const content = 'export const ancestor = true;\n';
  const stream = Array.from({ length: distance }, (_, i) => {
    const message = `change ${i}\n`;
    return `commit refs/heads/feature\nmark :${i + 1}\ncommitter Test <test@example.invalid> 1700000000 +0000\ndata ${message.length}\n${message}from ${i === 0 ? base : `:${i}`}\nM 100644 inline ancestral.ts\ndata ${content.length}\n${content}\n`;
  }).join('');
  execFileSync('git', ['-C', upstream, 'fast-import', '--quiet'], { env, input: stream });
  git(upstream, 'reset', '--hard', 'HEAD');
  git(upstream, 'checkout', '-q', 'main');
  git(upstream, 'commit', '--allow-empty', '-qm', 'main diverges');
  const repo = join(root, 'clone');
  execFileSync(
    'git',
    ['clone', '-q', '--depth=1', '--branch=feature', pathToFileURL(upstream).href, repo],
    { env },
  );
  writeFileSync(join(repo, 'changed.ts'), 'export const value = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'local change');
  return { repo, base, upstream };
}
function resolve(
  repo: string,
  base = 'origin/main',
  path = env.PATH,
): ReturnType<typeof spawnSync> {
  return spawnSync(
    'bash',
    [
      '-c',
      'source "$1"; verity_resolve_review_base "$2" HEAD; status=$?; printf "%s\\n%s\\n" "$VERITY_MERGE_BASE" "$VERITY_BASE_REASON"; exit "$status"',
      'test',
      helper,
      base,
    ],
    { cwd: repo, env: { ...env, PATH: path }, encoding: 'utf8' },
  );
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bounded review base recovery', () => {
  it.each([false, true])(
    'recovers both branches while preserving unpublished commits, existing base=%s',
    (existing) => {
      const { repo, base } = fixture();
      const head = git(repo, 'rev-parse', 'HEAD');
      if (existing)
        git(
          repo,
          'fetch',
          '-q',
          '--depth=1',
          'origin',
          '+refs/heads/main:refs/remotes/origin/main',
        );
      const result = resolve(repo);
      expect(result.status).toBe(0);
      expect(result.stdout.toString().split('\n')[0]).toBe(base);
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
      expect(resolve(repo).stderr).toBe('');
    },
  );
  it.each(['remotes/origin/main', 'refs/remotes/origin/main'])(
    'normalizes the remote-tracking base %s',
    (baseRef) => {
      const { repo, base } = fixture();
      const result = resolve(repo, baseRef);
      expect(result.status).toBe(0);
      expect(result.stdout.toString().split('\n')[0]).toBe(base);
    },
  );
  it('does not truncate existing ancestry in a complete repository', () => {
    const { repo } = fixture();
    git(repo, 'fetch', '-q', '--unshallow', 'origin');
    const head = git(repo, 'rev-parse', 'HEAD');
    const result = resolve(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('restore it explicitly');
    expect(result.stderr).not.toContain('attempt');
    expect(git(repo, 'rev-parse', '--is-shallow-repository')).toBe('false');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
  });
  it('recovers through another ancestor when the first tracking branch was deleted', () => {
    const { repo, base } = fixture();
    git(
      repo,
      'update-ref',
      'refs/remotes/origin/deleted',
      git(repo, 'rev-parse', 'origin/feature'),
    );
    const result = resolve(repo);
    expect(result.status).toBe(0);
    expect(result.stdout.toString().split('\n')[0]).toBe(base);
    expect(result.stderr.toString().match(/attempt/g)).toHaveLength(2);
  });
  it('does not guess a remote for a local or unavailable base', () => {
    const { repo } = fixture();
    const result = resolve(repo, 'refs/heads/missing');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('not a configured remote-tracking ref');
    expect(result.stderr).not.toContain('attempt');
  });
  it('reports a failed remote without accepting a comparison base', () => {
    const { repo } = fixture();
    git(repo, 'remote', 'set-url', 'origin', join(repo, 'missing'));
    const result = resolve(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('fetch failed or timed out');
    expect(result.stdout.toString().startsWith('\n')).toBe(true);
  });
  it('stops when the checked-in history budget is exhausted', () => {
    const source = readFileSync(helper, 'utf8');
    const depth = Number(/--deepen=(\d+)/.exec(source)?.[1]);
    const attempts = /for attempt in ([\d ]+);/.exec(source)![1].trim().split(' ').length;
    const { repo } = fixture(depth * attempts + 10);
    const result = resolve(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('history recovery limit');
    expect(result.stderr.toString().match(/attempt/g)).toHaveLength(attempts);
  });
  it('preserves already reachable history when a missing base exceeds the recovery budget', () => {
    const source = readFileSync(helper, 'utf8');
    const depth = Number(/--deepen=(\d+)/.exec(source)?.[1]);
    const attempts = /for attempt in ([\d ]+);/.exec(source)![1].trim().split(' ').length;
    const budget = depth * attempts;
    const { repo } = fixture(budget * 5);
    git(repo, 'fetch', '-q', `--deepen=${budget * 2 + 10}`, 'origin', 'feature');
    const reachable = git(repo, 'rev-list', 'HEAD').split('\n');
    expect(reachable.length).toBeGreaterThan(budget);
    expect(git(repo, 'for-each-ref', 'refs/remotes/origin/main')).toBe('');
    const result = resolve(repo);
    expect(result.status).toBe(1);
    // A shortened shallow boundary silently removes commits from secret scans.
    const after = new Set(git(repo, 'rev-list', 'HEAD').split('\n'));
    expect(reachable.every((sha) => after.has(sha))).toBe(true);
    expect(result.stdout).toContain('history recovery limit');
  });
  it('uses the timeout wrapper and treats its failure as an unavailable base', () => {
    const { repo } = fixture();
    const bin = join(repo, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'timeout'),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$TIMEOUT_LOG"\nexit 124\n',
      {
        mode: 0o755,
      },
    );
    const log = join(repo, 'timeout.log');
    const result = spawnSync(
      'bash',
      [
        '-c',
        'source "$1"; verity_resolve_review_base origin/main HEAD; status=$?; echo "$VERITY_BASE_REASON"; exit "$status"',
        'test',
        helper,
      ],
      {
        cwd: repo,
        env: { ...env, PATH: `${bin}:${env.PATH}`, TIMEOUT_LOG: log },
        encoding: 'utf8',
      },
    );
    expect(readFileSync(log, 'utf8')).toContain('git -c credential.interactive=false fetch');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('fetch failed or timed out');
    expect(git(repo, 'rev-parse', '--is-shallow-repository')).toBe('true');
  });
  it.each([false, true])('runs scoped checks after recovery, with failed remote=%s', (failed) => {
    const { repo } = fixture();
    if (failed) git(repo, 'remote', 'set-url', 'origin', join(repo, 'missing'));
    mkdirSync(join(repo, 'node_modules'));
    mkdirSync(join(repo, '.agents'));
    writeFileSync(join(repo, '.agents/.last-code-review-sha'), git(repo, 'rev-parse', 'HEAD'));
    const scan = join(repo, 'scan');
    writeFileSync(
      scan,
      '#!/bin/sh\necho secret-scanned >&2\nif [ "$1" = range ]; then git log --format=%s "$2..$3" >&2; fi\nexit 0\n',
      { mode: 0o755 },
    );
    const result = spawnSync(hook, [], {
      cwd: repo,
      env: { ...env, VERITY_SECRET_SCAN_BIN: scan },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('secret-scanned');
    if (!failed) {
      expect(result.stderr).toContain('change 0');
      expect(result.stderr).toContain('scoped-lint ancestral.ts changed.ts');
    }
    expect(result.stderr).toContain(failed ? 'full-lint' : 'scoped-lint');
    expect(result.stderr).toContain(failed ? 'full-format' : 'scoped-format');
    // Recovery can need another deepen after creating the missing base ref.
    // Repeating it between gates would add network work to each scoped check.
    expect(result.stderr.toString().split('secret-scanned').slice(1).join('')).not.toContain(
      'review-base: recovering',
    );
    if (failed) expect(result.stderr.toString().match(/attempt/g)).toHaveLength(1);
  });
  it('allows the review CLI to report a recovered diff', () => {
    const { repo } = fixture();
    const result = spawnSync(cli, ['status'], { cwd: repo, env, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('changed.ts');
  });
  it.each(['config', 'multiple refs'])('keeps full checks for %s', (mode) => {
    const { repo } = fixture();
    if (mode === 'config') {
      writeFileSync(
        join(repo, 'package.json'),
        readFileSync(join(repo, 'package.json'), 'utf8') + '\n',
      );
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'configuration changes');
    }
    mkdirSync(join(repo, 'node_modules'));
    mkdirSync(join(repo, '.agents'));
    const head = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, '.agents/.last-code-review-sha'), head);
    const scan = join(repo, 'scan');
    writeFileSync(scan, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const zero = '0'.repeat(head.length);
    const input =
      mode === 'multiple refs'
        ? `refs/heads/feature ${head} refs/heads/feature ${zero}\nrefs/heads/other ${head} refs/heads/other ${zero}\n`
        : undefined;
    const result = spawnSync(hook, [], {
      cwd: repo,
      env: { ...env, VERITY_SECRET_SCAN_BIN: scan },
      input,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('full-lint');
    expect(result.stderr).toContain('full-format');
    expect(result.stderr).not.toContain('scoped-lint');
  });
  it('reports a recovery command when the CLI cannot find an ancestor', () => {
    const { repo } = fixture();
    git(repo, 'remote', 'remove', 'origin');
    const result = spawnSync(cli, ['status'], { cwd: repo, env, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('verity-code-review status <other-base-ref>');
  });
  it('ships and installs the shared helper', () => {
    expect(
      readFileSync(
        new URL(
          '../features/verity-sandbox-toolkit/agent-seed/bin/verity-review-base.sh',
          import.meta.url,
        ),
        'utf8',
      ),
    ).toBe(readFileSync(helper, 'utf8'));
    expect(
      readFileSync(
        new URL('../features/verity-sandbox-toolkit/install.sh', import.meta.url),
        'utf8',
      ),
    ).toContain(
      'install -m 0644 "$FEATURE_DIR/agent-seed/bin/verity-review-base.sh" /opt/agent-seed/bin/verity-review-base.sh',
    );
  });
});
