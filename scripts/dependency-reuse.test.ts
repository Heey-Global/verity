import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  readlinkSync,
  utimesSync,
  openSync,
  closeSync,
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
const env = {
  ...process.env,
  VERITY_SESSION_ID: '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
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
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] === '--version') { console.log('12.2.2'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(called)}, process.cwd() + '\\n' + process.argv.slice(2).join('\\n') + '\\n');
const complete = () => {
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  fs.mkdirSync('node_modules', {recursive:true});
  if (fs.existsSync('.npm-fail')) process.exit(42);
  for (const [file, value] of Object.entries(lock.packages ?? {})) {
    if (!file.startsWith('node_modules/')) continue;
    if (value.link) {
      fs.mkdirSync(path.dirname(file), {recursive:true});
      fs.symlinkSync(path.relative(path.dirname(file), value.resolved), file);
    } else {
      fs.mkdirSync(file, {recursive:true});
      fs.writeFileSync(path.join(file, 'package.json'), JSON.stringify({version:value.version}));
      if (file === 'node_modules/private') {
        fs.writeFileSync(path.join(file,'cli.js'),'// private cli');
        fs.mkdirSync('node_modules/.bin',{recursive:true});
        fs.symlinkSync('../private/cli.js','node_modules/.bin/private');
      }
    }
  }
  fs.writeFileSync('node_modules/.package-lock.json', JSON.stringify(lock));
};
setTimeout(complete, fs.existsSync('.npm-delay') ? Number(fs.readFileSync('.npm-delay', 'utf8')) : 0);
`,
    { mode: 0o755 },
  );
  const run = (action: string, extraEnv: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [helper, action], {
      cwd: worktree,
      env: { ...env, PATH: `${bin}:${process.env.PATH}`, ...extraEnv },
      encoding: 'utf8',
    });
  const start = (cwd = worktree) =>
    spawn(process.execPath, [helper, 'install'], {
      cwd,
      env: { ...env, PATH: `${bin}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const sibling = () => {
    const directory = join(root, '.verity-sessions', 'sibling');
    git('-C', root, 'worktree', 'add', '-qb', 'sibling', directory);
    return directory;
  };
  return { root, worktree, called, run, start, sibling };
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
  it('reuses a compatible private npm installation on repeated install requests', () => {
    const f = fixture();
    mkdirSync(join(f.worktree, 'node_modules'));
    writeFileSync(join(f.worktree, 'node_modules', '.package-lock.json'), '{"packages":{}}');
    expect(f.run('status').status).toBe(0);
    expect(f.run('install').status).toBe(0);
    expect(f.run('install').status).toBe(0);
    expect(existsSync(f.called)).toBe(false);
  });
  it('keeps divergent lockfiles isolated and never installs in the shared root', () => {
    const f = fixture();
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      '{"lockfileVersion":3,"packages":{"node_modules/private":{"version":"1.0.0"}}}',
    );
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
    expect(existsSync(f.called)).toBe(false);
    const preserved = join(f.root, '.git', 'worktrees', 'test', 'verity-dependencies-preserved');
    expect(
      readFileSync(join(preserved, readdirSync(preserved)[0]!, 'stale', 'package.json'), 'utf8'),
    ).toContain('old');
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
  it('accepts declared local npm links outside the checkout', () => {
    const f = fixture();
    const target = resolve(f.worktree, '../shared');
    mkdirSync(target);
    writeFileSync(join(target, 'package.json'), '{"name":"shared"}');
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/shared': { link: true, resolved: '../shared' } },
      }),
    );
    mkdirSync(join(f.worktree, 'node_modules'));
    writeFileSync(join(f.worktree, 'node_modules', '.package-lock.json'), '{"packages":{}}');
    symlinkSync(target, join(f.worktree, 'node_modules', 'shared'));
    expect(f.run('status').status).toBe(0);
  });
  it('reuses a prepared divergent installation across sessions with independent files', () => {
    const f = fixture();
    const sibling = f.sibling();
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/private': { version: '2.0.0' } },
    });
    writeFileSync(join(f.worktree, 'package-lock.json'), lock);
    writeFileSync(join(sibling, 'package-lock.json'), lock);
    expect(f.run('install').status).toBe(0);
    const child = spawnSync(process.execPath, [helper, 'install'], {
      cwd: sibling,
      env: { ...env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    expect(child.status, child.stderr).toBe(0);
    expect(readFileSync(f.called, 'utf8').match(/\nci\n/g)).toHaveLength(1);
    expect(readlinkSync(join(sibling, 'node_modules', '.bin', 'private'))).toBe(
      '../private/cli.js',
    );
    expect(realpathSync(join(sibling, 'node_modules', '.bin', 'private'))).toBe(
      join(sibling, 'node_modules', 'private', 'cli.js'),
    );
    writeFileSync(join(sibling, 'node_modules', 'private', 'package.json'), '{"patched":true}');
    expect(
      readFileSync(join(f.worktree, 'node_modules', 'private', 'package.json'), 'utf8'),
    ).toContain('2.0.0');
  });
  it('rewires cached workspace links to the receiving session', () => {
    const f = fixture();
    const sibling = f.sibling();
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/private': { version: '2.0.0' },
        'node_modules/source': { link: true, resolved: 'packages/source' },
      },
    });
    for (const directory of [f.worktree, sibling]) {
      mkdirSync(join(directory, 'packages', 'source'), { recursive: true });
      writeFileSync(join(directory, 'packages', 'source', 'package.json'), '{"name":"source"}');
      writeFileSync(join(directory, 'package-lock.json'), lock);
    }
    expect(f.run('install').status).toBe(0);
    const child = spawnSync(process.execPath, [helper, 'install'], {
      cwd: sibling,
      env: { ...env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    expect(child.status, child.stderr).toBe(0);
    expect(realpathSync(join(sibling, 'node_modules', 'source'))).toBe(
      join(sibling, 'packages', 'source'),
    );
    expect(readFileSync(f.called, 'utf8').match(/\nci\n/g)).toHaveLength(1);
  });
  it('preserves failed installation files and verifies a successful retry', () => {
    const f = fixture();
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/private': { version: '2.0.0' } },
      }),
    );
    writeFileSync(join(f.worktree, '.npm-fail'), 'fail');
    const failed = f.run('install');
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('failed (42)');
    expect(f.run('status').status).toBe(1);
    writeFileSync(join(f.worktree, 'node_modules', 'patch.txt'), 'keep');
    rmSync(join(f.worktree, '.npm-fail'));
    expect(f.run('install').status).toBe(0);
    expect(f.run('status').status).toBe(0);
    const preserved = join(f.root, '.git', 'worktrees', 'test', 'verity-dependencies-preserved');
    expect(
      readdirSync(preserved).some((entry) => existsSync(join(preserved, entry, 'patch.txt'))),
    ).toBe(true);
  });
  it('does not trust a managed receipt after install configuration changes', () => {
    const f = fixture();
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/private': { version: '2.0.0' } },
      }),
    );
    expect(f.run('install').status).toBe(0);
    writeFileSync(join(f.worktree, '.npmrc'), 'omit=dev\n');
    expect(f.run('status').status).toBe(1);
  });
  it('serializes same-identity sessions and prepares their dependencies once', async () => {
    const f = fixture();
    const sibling = f.sibling();
    for (const directory of [f.worktree, sibling]) {
      writeFileSync(
        join(directory, 'package-lock.json'),
        JSON.stringify({
          lockfileVersion: 3,
          packages: { 'node_modules/private': { version: '2.0.0' } },
        }),
      );
      writeFileSync(join(directory, '.npm-delay'), '500');
    }
    const first = f.start();
    const second = f.start(sibling);
    const statuses = await Promise.all(
      [first, second].map(
        (child) =>
          new Promise((done, reject) => {
            child.on('error', reject);
            child.on('close', done);
          }),
      ),
    );
    expect(statuses).toEqual([0, 0]);
    expect(readFileSync(f.called, 'utf8').match(/\nci\n/g)).toHaveLength(1);
  });
  it('releases preparation locks after interruption and does not mark the install ready', async () => {
    const f = fixture();
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/private': { version: '2.0.0' } },
      }),
    );
    writeFileSync(join(f.worktree, '.npm-delay'), '10000');
    const child = f.start();
    const exited = new Promise((done, reject) => {
      child.on('error', reject);
      child.on('close', done);
    });
    const deadline = Date.now() + 10000;
    while (!existsSync(f.called) && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 25));
    expect(existsSync(f.called)).toBe(true);
    child.kill('SIGTERM');
    expect(await exited).toBe(143);
    expect(f.run('status').status).toBe(1);
    rmSync(join(f.worktree, '.npm-delay'));
    expect(f.run('install').status).toBe(0);
  });
  it('keeps the checkout locked when the helper is killed before native npm exits', async () => {
    const f = fixture();
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/private': { version: '2.0.0' } },
      }),
    );
    writeFileSync(join(f.worktree, '.npm-delay'), '2000');
    const child = f.start();
    const exited = new Promise((done) => child.on('exit', done));
    const drained = new Promise((done) => child.on('close', done));
    const deadline = Date.now() + 10000;
    while (!existsSync(f.called) && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 25));
    expect(existsSync(f.called)).toBe(true);
    child.kill('SIGKILL');
    await exited;
    try {
      const lock = join(f.root, '.git', 'worktrees', 'test', 'verity-npm.lock');
      expect(spawnSync('flock', ['-n', lock, 'true']).status).toBe(1);
    } finally {
      await drained;
    }
    expect(f.run('status').status).toBe(0);
  });
  it.skipIf(existsSync('/usr/local/lib/verity/verity-npm-preflight.mjs'))(
    'blocks session reuse when the trusted age verifier is missing',
    () => {
      const f = fixture();
      const result = f.run('install', { VERITY_SESSION_ID: 'session-test' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('rebuild the project sandbox');
      expect(existsSync(f.called)).toBe(false);
    },
  );
  it('rejects incomplete published snapshots instead of activating them', () => {
    const f = fixture();
    const sibling = f.sibling();
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/private': { version: '2.0.0' } },
    });
    for (const directory of [f.worktree, sibling])
      writeFileSync(join(directory, 'package-lock.json'), lock);
    expect(f.run('install').status).toBe(0);
    const directory = join(f.root, '.git', 'verity-dependencies');
    const snapshot = readdirSync(directory).find((name) => /^[a-f0-9]{64}$/.test(name))!;
    rmSync(join(directory, snapshot, 'node_modules', 'private', 'package.json'));
    const result = spawnSync(process.execPath, [helper, 'install'], {
      cwd: sibling,
      env: { ...env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(f.called, 'utf8').match(/\nci\n/g)).toHaveLength(2);
  });
  it('invalidates managed packed file dependencies when local source bytes change', () => {
    const f = fixture();
    mkdirSync(join(f.worktree, 'vendor', 'local'), { recursive: true });
    writeFileSync(
      join(f.worktree, 'vendor', 'local', 'package.json'),
      '{"name":"local","version":"1.0.0"}',
    );
    writeFileSync(join(f.worktree, 'vendor', 'local', 'index.js'), 'export default 1;');
    writeFileSync(join(f.worktree, '.npmrc'), 'install-links=true\n');
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/local': { version: '1.0.0', resolved: 'file:vendor/local' } },
      }),
    );
    expect(f.run('install').status).toBe(0);
    expect(f.run('status').status).toBe(0);
    writeFileSync(join(f.worktree, 'vendor', 'local', 'index.js'), 'export default 2;');
    expect(f.run('status').status).toBe(1);
    expect(f.run('install').status).toBe(0);
    expect(readFileSync(f.called, 'utf8').match(/\nci\n/g)).toHaveLength(2);
  });
  it('does not trust legacy packed file receipts without source identity', () => {
    const f = fixture();
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/local': { version: '1.0.0', resolved: 'file:vendor/local' } },
    });
    for (const directory of [f.root, f.worktree]) {
      mkdirSync(join(directory, 'vendor', 'local'), { recursive: true });
      writeFileSync(
        join(directory, 'vendor', 'local', 'package.json'),
        '{"name":"local","version":"1.0.0"}',
      );
      writeFileSync(join(directory, 'package-lock.json'), lock);
      mkdirSync(join(directory, 'node_modules', 'local'), { recursive: true });
      writeFileSync(
        join(directory, 'node_modules', 'local', 'package.json'),
        '{"version":"1.0.0"}',
      );
      writeFileSync(join(directory, 'node_modules', '.package-lock.json'), lock);
    }
    expect(f.run('status').status).toBe(1);
    rmSync(join(f.worktree, 'node_modules'), { recursive: true });
    expect(f.run('status').status).toBe(1);
  });
  it('includes runtime libc in managed install compatibility', () => {
    const f = fixture();
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/private': { version: '2.0.0' } },
      }),
    );
    const preload = join(f.root, 'bin', 'libc.mjs');
    writeFileSync(
      preload,
      'process.report.getReport = () => ({header:{glibcVersionRuntime:process.env.TEST_LIBC}});\n',
    );
    const options = `${process.env.NODE_OPTIONS ?? ''} --import=${preload}`;
    expect(f.run('install', { NODE_OPTIONS: options, TEST_LIBC: '2.36' }).status).toBe(0);
    expect(f.run('status', { NODE_OPTIONS: options, TEST_LIBC: '2.36' }).status).toBe(0);
    expect(f.run('status', { NODE_OPTIONS: options, TEST_LIBC: '2.37' }).status).toBe(1);
  });
  it('rotates generated snapshots so the third dependency identity is reusable', () => {
    const f = fixture();
    const sibling = f.sibling();
    const cache = join(f.root, '.git', 'verity-dependencies');
    const lock = (version: string) =>
      JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/private': { version } } });
    writeFileSync(join(f.worktree, 'package-lock.json'), lock('1.0.0'));
    expect(f.run('install').status).toBe(0);
    const first = readdirSync(cache).find((name) => /^[a-f0-9]{64}$/.test(name))!;
    utimesSync(join(cache, first, 'receipt.json'), new Date(1000), new Date(1000));
    writeFileSync(join(f.worktree, 'package-lock.json'), lock('2.0.0'));
    expect(f.run('install').status).toBe(0);
    writeFileSync(join(f.worktree, 'package-lock.json'), lock('3.0.0'));
    expect(f.run('install').status).toBe(0);
    expect(readdirSync(cache).filter((name) => /^[a-f0-9]{64}$/.test(name))).toHaveLength(2);
    expect(existsSync(join(cache, first))).toBe(false);
    writeFileSync(join(sibling, 'package-lock.json'), lock('3.0.0'));
    const result = spawnSync(process.execPath, [helper, 'install'], {
      cwd: sibling,
      env: { ...env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(f.called, 'utf8').match(/\nci\n/g)).toHaveLength(3);
  });
  it('retains active snapshots and evicts only an unlocked generated identity', () => {
    const f = fixture();
    const cache = join(f.root, '.git', 'verity-dependencies');
    const lock = (version: string) =>
      JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/private': { version } } });
    writeFileSync(join(f.worktree, 'package-lock.json'), lock('1.0.0'));
    expect(f.run('install').status).toBe(0);
    const first = readdirSync(cache).find((name) => /^[a-f0-9]{64}$/.test(name))!;
    utimesSync(join(cache, first, 'receipt.json'), new Date(1000), new Date(1000));
    writeFileSync(join(f.worktree, 'package-lock.json'), lock('2.0.0'));
    expect(f.run('install').status).toBe(0);
    const second = readdirSync(cache).find(
      (name) => /^[a-f0-9]{64}$/.test(name) && name !== first,
    )!;
    const fd = openSync(join(cache, first + '.lock'), 'a');
    try {
      expect(
        spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] }).status,
      ).toBe(0);
      writeFileSync(join(f.worktree, 'package-lock.json'), lock('3.0.0'));
      expect(f.run('install').status).toBe(0);
      expect(existsSync(join(cache, first))).toBe(true);
      expect(existsSync(join(cache, second))).toBe(false);
    } finally {
      closeSync(fd);
    }
    expect(readdirSync(cache).filter((name) => /^[a-f0-9]{64}$/.test(name))).toHaveLength(2);
  });
  it('ships identical executable helpers in both seed trees', () => {
    expect(readFileSync(helper, 'utf8')).toBe(
      readFileSync('features/verity-sandbox-toolkit/agent-seed/bin/verity-dependencies', 'utf8'),
    );
  });
});
