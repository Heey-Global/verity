import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(wrapper: string) {
  const root = mkdtempSync(join(tmpdir(), 'verity-gh-guard-'));
  roots.push(root);
  const session = join(root, 'session');
  const other = join(root, 'other');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  execFileSync('git', ['init', '-b', 'fix/session', session]);
  execFileSync('git', [
    '-C',
    session,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'test',
  ]);
  execFileSync('git', ['-C', session, 'worktree', 'add', '-b', 'test/other', other]);
  for (const [name, source] of Object.entries({
    'verity-gh-token': '#!/bin/bash\necho fixture-token\n',
    'gh-real': `#!/bin/bash
if [ "$1" = repo ] && [ "$2" = view ]; then
  if [[ "$*" == *wrong/repo* ]] || [ -n "\${GH_REPO:-}" ]; then
    echo https://github.com/wrong/repo
  else
    echo https://github.com/acme/app
  fi
else
  printf '%s\\n' "$@"
fi
`,
  })) {
    writeFileSync(join(bin, name), source);
    chmodSync(join(bin, name), 0o755);
  }
  const run = (args: string[], cwd = session, extra: NodeJS.ProcessEnv = {}) =>
    spawnSync('bash', [resolve(wrapper), ...args], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        VERITY_GH_REAL: join(bin, 'gh-real'),
        VERITY_FORGE_MODE: 'proxy-test',
        VERITY_FORGE_PROXY_URL: 'http://fixture',
        VERITY_FORGE_PROXY_CA_FILE: '/fixture',
        VERITY_SESSION_WORKTREE: session,
        GH_REPO: '',
        ...extra,
      },
    });
  return { run, session, other };
}

describe.each(['agent-seed/bin/gh', 'features/verity-sandbox-toolkit/agent-seed/bin/gh'])(
  '%s session PR guard',
  (wrapper) => {
    it('pins the session head and permits an in-session branch switch', () => {
      const { run, session } = fixture(wrapper);
      expect(run(['pr', 'create', '--title', 'Other --head text']).stdout).toContain(
        '--head\nfix/session',
      );
      execFileSync('git', ['-C', session, 'switch', '-c', 'fix/new']);
      expect(run(['pr', 'create']).stdout).toContain('--head\nfix/new');
    });
    it.each([
      ['--head', 'test/other'],
      ['--head=test/other'],
      ['-Htest/other'],
      ['-H', 'intruder:fix/session'],
      ['-R', 'wrong/repo'],
      ['--repo=wrong/repo'],
    ])('blocks incompatible options %j', (...flags) => {
      const { run } = fixture(wrapper);
      const result = run(['pr', 'create', ...flags]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('verity PR guard:');
    });
    it('blocks a foreign worktree and GH_REPO override', () => {
      const { run, other } = fixture(wrapper);
      expect(run(['pr', 'create'], other).status).toBe(1);
      expect(run(['pr', 'create'], undefined, { GH_REPO: 'wrong/repo' }).status).toBe(1);
    });
    it('accepts explicit matching repository and owner-qualified head', () => {
      const { run } = fixture(wrapper);
      expect(run(['-R', 'acme/app', 'pr', 'create', '--head=acme:fix/session']).status).toBe(0);
    });
    it('fails closed without launch context or a branch, but leaves reads and help alone', () => {
      const { run, session } = fixture(wrapper);
      expect(run(['pr', 'create'], session, { VERITY_SESSION_WORKTREE: '' }).status).toBe(1);
      execFileSync('git', ['-C', session, 'checkout', '--detach']);
      expect(run(['pr', 'create']).status).toBe(1);
      expect(run(['pr', 'view'], session, { VERITY_SESSION_WORKTREE: '' }).status).toBe(0);
      expect(run(['pr', 'create', '--help']).status).toBe(0);
    });
  },
);
