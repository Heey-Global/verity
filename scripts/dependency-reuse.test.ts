import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const helper = resolve('agent-seed/bin/verity-dependencies');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'verity-deps-'));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      env,
      stdio: 'ignore',
    });
  git('init', '-q', root);
  git('-C', root, 'config', 'user.name', 'Test');
  git('-C', root, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'package.json'), '{"name":"test","version":"1.0.0"}');
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n.verity-sessions/\nbin/\n');
  git('-C', root, 'add', '.');
  git('-C', root, 'commit', '-qm', 'initial');
  const worktree = join(root, '.verity-sessions', 'test');
  git('-C', root, 'worktree', 'add', '-qb', 'test', worktree);
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(
    join(root, 'node_modules', '.package-lock.json'),
    '{"lockfileVersion":3,"packages":{}}',
  );
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const called = join(bin, 'called');
  writeFileSync(
    join(bin, 'npm'),
    `#!/bin/sh\npwd > '${called}'\nprintf '%s\\n' "$@" >> '${called}'\n`,
    { mode: 0o755 },
  );
  const run = (action: string) =>
    spawnSync(process.execPath, [helper, action], {
      cwd: worktree,
      env: { ...env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    });
  return { root, worktree, called, run };
}
describe('shared dependency reuse', () => {
  it('reuses compatible ancestor dependencies without installing private copies', () => {
    const f = fixture();
    mkdirSync(join(f.worktree, 'node_modules', '@first-party'), { recursive: true });
    expect(f.run('status').status).toBe(0);
    expect(f.run('install').status).toBe(0);
    expect(existsSync(f.called)).toBe(false);
    expect(existsSync(join(f.worktree, 'node_modules', '.package-lock.json'))).toBe(false);
  });
  it('keeps divergent lockfiles isolated and never installs in the shared root', () => {
    const f = fixture();
    writeFileSync(join(f.worktree, 'package-lock.json'), '{"changed":true}');
    expect(f.run('status').status).toBe(1);
    expect(f.run('install').status).toBe(0);
    expect(readFileSync(f.called, 'utf8')).toContain(`${f.worktree}\nci\n--ignore-scripts`);
  });
  it('does not mistake an empty workspace skeleton for installed dependencies', () => {
    const f = fixture();
    rmSync(join(f.root, 'node_modules', '.package-lock.json'));
    mkdirSync(join(f.worktree, 'node_modules'));
    expect(f.run('status').status).toBe(1);
  });
  it('rejects an untracked workspace manifest and preserves private installs', () => {
    const f = fixture();
    mkdirSync(join(f.worktree, 'packages', 'extra'), { recursive: true });
    writeFileSync(join(f.worktree, 'packages', 'extra', 'package.json'), '{}');
    expect(f.run('status').status).toBe(1);
    mkdirSync(join(f.worktree, 'node_modules'));
    writeFileSync(join(f.worktree, 'node_modules', '.package-lock.json'), '{"packages":{}}');
    expect(f.run('status').status).toBe(0);
  });
  it('does not install again for release metadata or script-only changes', () => {
    const f = fixture();
    writeFileSync(
      join(f.worktree, 'package.json'),
      '{"name":"test","version":"2.0.0","scripts":{"lint":"custom"}}',
    );
    expect(f.run('status').status).toBe(0);
  });
  it('rejects stale installed receipts even when source manifests agree', () => {
    const f = fixture();
    const lock = '{"lockfileVersion":3,"packages":{"node_modules/required":{"version":"1.0.0"}}}';
    writeFileSync(join(f.root, 'package-lock.json'), lock);
    writeFileSync(join(f.worktree, 'package-lock.json'), lock);
    expect(f.run('status').status).toBe(1);
  });
  it('rejects stale private packages shadowing a compatible shared installation', () => {
    const f = fixture();
    mkdirSync(join(f.worktree, 'node_modules', 'stale'), { recursive: true });
    writeFileSync(join(f.worktree, 'node_modules', 'stale', 'package.json'), '{"version":"old"}');
    expect(f.run('status').status).toBe(1);
    expect(f.run('install').status).toBe(0);
    expect(readFileSync(f.called, 'utf8')).toContain(f.worktree);
  });
  it('recognizes npm v1 source locks against modern installation receipts', () => {
    const f = fixture();
    for (const root of [f.root, f.worktree])
      writeFileSync(
        join(root, 'package-lock.json'),
        JSON.stringify({
          lockfileVersion: 1,
          dependencies: { dep: { version: '1.0.0', integrity: 'hash' } },
        }),
      );
    mkdirSync(join(f.root, 'node_modules', 'dep'));
    writeFileSync(join(f.root, 'node_modules', 'dep', 'package.json'), '{"version":"1.0.0"}');
    writeFileSync(
      join(f.root, 'node_modules', '.package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/dep': { version: '1.0.0', integrity: 'hash' } },
      }),
    );
    expect(f.run('status').status).toBe(0);
  });
  it.each(['yarn', 'pnpm'])(
    'recognizes an existing %s install without switching package managers',
    (manager) => {
      const f = fixture();
      writeFileSync(
        join(f.worktree, 'package.json'),
        JSON.stringify({ packageManager: `${manager}@1.0.0` }),
      );
      mkdirSync(join(f.worktree, 'node_modules'), { recursive: true });
      if (manager === 'yarn') {
        writeFileSync(
          join(f.root, 'bin', 'yarn'),
          '#!/bin/sh\n[ "$*" = "check --integrity --offline" ] && [ ! -f stale ]\n',
          { mode: 0o755 },
        );
        writeFileSync(
          join(f.worktree, 'node_modules', '.yarn-integrity'),
          JSON.stringify({ topLevelPatterns: [], lockfileEntries: {} }),
        );
      } else {
        writeFileSync(join(f.worktree, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
        writeFileSync(join(f.worktree, 'node_modules', '.modules.yaml'), 'layoutVersion: 5');
        mkdirSync(join(f.worktree, 'node_modules', '.pnpm'));
        writeFileSync(join(f.worktree, 'node_modules', '.pnpm', 'lock.yaml'), 'lockfileVersion: 9');
      }
      expect(f.run('status').status).toBe(0);
      expect(f.run('install').status).toBe(0);
      expect(existsSync(f.called)).toBe(false);
      if (manager === 'yarn') {
        writeFileSync(join(f.worktree, 'stale'), 'native integrity check fails');
        expect(f.run('status').status).toBe(1);
        expect(f.run('install').status).toBe(1);
        expect(existsSync(f.called)).toBe(false);
      }
      rmSync(join(f.worktree, 'node_modules'), { recursive: true });
      expect(f.run('install').status).toBe(1);
      expect(existsSync(f.called)).toBe(false);
    },
  );
  it('requires npm workspace links to exist and target their declared workspace', () => {
    const f = fixture();
    mkdirSync(join(f.worktree, 'packages', 'source'), { recursive: true });
    mkdirSync(join(f.worktree, 'packages', 'other'), { recursive: true });
    for (const name of ['source', 'other'])
      writeFileSync(join(f.worktree, 'packages', name, 'package.json'), '{}');
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/source': { link: true, resolved: 'packages/source' } },
      }),
    );
    mkdirSync(join(f.worktree, 'node_modules'));
    writeFileSync(join(f.worktree, 'node_modules', '.package-lock.json'), '{"packages":{}}');
    expect(f.run('status').status).toBe(1);
    symlinkSync('../packages/other', join(f.worktree, 'node_modules', 'source'));
    expect(f.run('status').status).toBe(1);
    rmSync(join(f.worktree, 'node_modules', 'source'));
    symlinkSync('../packages/source', join(f.worktree, 'node_modules', 'source'));
    expect(f.run('status').status).toBe(0);
  });
  it('ships identical executable helpers in both seed trees', () => {
    expect(readFileSync(helper, 'utf8')).toBe(
      readFileSync('features/verity-sandbox-toolkit/agent-seed/bin/verity-dependencies', 'utf8'),
    );
  });
});
