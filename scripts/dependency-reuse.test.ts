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
  chmodSync,
  cpSync,
  rmSync,
  symlinkSync,
  statSync,
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
  // npm test exports its own configuration paths; the fake npm must use the
  // fixture's global configuration so drift assertions exercise that file.
  NPM_CONFIG_GLOBALCONFIG: undefined,
  npm_config_globalconfig: undefined,
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
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const called = join(bin, 'called');
  writeFileSync(
    join(bin, 'npm'),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] === 'prefix') { console.log(fs.existsSync(${JSON.stringify(join(bin, '.npm-prefix-redirect'))}) ? ${JSON.stringify(root)} : process.cwd()); process.exit(0); }
if (process.argv[2] === 'config' && process.argv[4] === 'cafile') { const config = fs.existsSync('.npmrc') ? fs.readFileSync('.npmrc','utf8') : ''; const value = /^cafile=(.+)$/m.exec(config)?.[1]; console.log(value ? path.resolve(value) : 'null'); process.exit(0); }
if (process.argv[2] === '--version') { console.log('12.2.2'); process.exit(0); }
if (process.argv[2] === 'config' && process.argv[3] === 'get' && ['globalconfig','userconfig'].includes(process.argv[4])) { const key=process.argv[4]; console.log(process.env['NPM_CONFIG_'+key.toUpperCase()] ?? process.env['npm_config_'+key] ?? path.join(${JSON.stringify(bin)},key+'.npmrc')); process.exit(0); }

fs.appendFileSync(${JSON.stringify(called)}, process.cwd() + '\\n' + process.argv.slice(2).join('\\n') + '\\n');
const complete = () => {
  if (process.env.TEST_EXPECTED_CAFILE && (process.env.npm_config_cafile !== process.env.TEST_EXPECTED_CAFILE || fs.readFileSync(process.env.npm_config_cafile, 'utf8') !== 'certificate')) process.exit(50);
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  fs.mkdirSync('node_modules', {recursive:true});
  if (process.env.NPM_CONFIG_USERCONFIG && !path.isAbsolute(process.env.NPM_CONFIG_USERCONFIG)) process.exit(48);
  if (process.env.TEST_EXPECTED_USERCONFIG_CONTENT && fs.readFileSync(process.env.NPM_CONFIG_USERCONFIG, 'utf8') !== process.env.TEST_EXPECTED_USERCONFIG_CONTENT) process.exit(49);
  if (fs.existsSync(${JSON.stringify(join(bin, '.npm-fail'))})) process.exit(42);
  if (fs.existsSync(${JSON.stringify(join(bin, '.npm-required-source'))})) {
    const expected = JSON.parse(fs.readFileSync(${JSON.stringify(join(bin, '.npm-required-source'))}, 'utf8'));
    for (const [file, contents] of Object.entries(expected)) {
      if (fs.readFileSync(file, 'utf8') !== contents) process.exit(43);
    }
  }
  const packages = {...(lock.packages ?? {})};
  const collect = (dependencies,prefix='') => { for (const [name,value] of Object.entries(dependencies ?? {})) { const entry=prefix+'node_modules/'+name; packages[entry]=value; collect(value.dependencies,entry+'/'); } };
  if (!lock.packages) collect(lock.dependencies);
  for (const [file, value] of Object.entries(packages)) {
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
  fs.writeFileSync('node_modules/.package-lock.json', JSON.stringify({lockfileVersion:3,packages}));
  if (fs.existsSync(${JSON.stringify(join(bin, '.npm-change-config'))})) fs.appendFileSync('.npmrc','engine-strict=false\\n');
};
setTimeout(complete, fs.existsSync(${JSON.stringify(join(bin, '.npm-delay'))}) ? Number(fs.readFileSync(${JSON.stringify(join(bin, '.npm-delay'))}, 'utf8')) : 0);
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
  // Model provisioning with a genuine helper receipt, rather than forging an
  // identity that could let a weaker compatibility check pass unnoticed.
  const prepared = run('install');
  if (prepared.status !== 0)
    throw new Error(`Fixture dependency preparation failed: ${prepared.stderr}`);
  cpSync(join(worktree, 'node_modules'), join(root, 'node_modules'), {
    recursive: true,
    verbatimSymlinks: true,
  });
  rmSync(join(worktree, 'node_modules'), { recursive: true });
  rmSync(join(root, '.git', 'verity-dependencies'), { recursive: true, force: true });
  rmSync(called, { force: true });
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
  it('reuses a compatible managed private installation on repeated install requests', () => {
    const f = fixture();
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/private': { version: '1.0.0' } },
      }),
    );
    expect(f.run('install').status).toBe(0);
    expect(f.run('status').status).toBe(0);
    expect(f.run('install').status).toBe(0);
    expect(f.run('install').status).toBe(0);
    expect(readFileSync(f.called, 'utf8').match(/\nci\n/g)).toHaveLength(1);
  });
  it('prepares divergent lockfiles centrally without installing in either checkout', () => {
    const f = fixture();
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      '{"lockfileVersion":3,"packages":{"node_modules/private":{"version":"1.0.0"}}}',
    );
    expect(f.run('status').status).toBe(1);
    expect(f.run('install').status).toBe(0);
    const invocation = readFileSync(f.called, 'utf8');
    expect(invocation.split('\n')[0]).toMatch(/\/verity-dependencies\/[a-f0-9]{64}\.prepare$/u);
    expect(invocation).toContain('\nci\n--ignore-scripts');
    expect(invocation).not.toContain(`${f.worktree}\n`);
    expect(invocation).not.toContain(`${f.root}\n`);
  });
  it('rejects unlocked preparation without falling back to npm install in the session', () => {
    const f = fixture();
    rmSync(join(f.worktree, 'package-lock.json'));
    const result = f.run('install');
    expect(result.status).toBe(1);
    expect(existsSync(f.called)).toBe(false);
    expect(existsSync(join(f.worktree, 'node_modules'))).toBe(false);
  });
  it('does not activate dependencies when central publication cannot acquire its lock', () => {
    const f = fixture();
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/private': { version: '2.0.0' } },
      }),
    );
    const cache = join(f.root, '.git', 'verity-dependencies');
    mkdirSync(join(cache, 'publication.lock'), { recursive: true });
    const result = f.run('install');
    expect(result.status).toBe(1);
    expect(existsSync(join(f.worktree, 'node_modules', '.verity-install.json'))).toBe(false);
    expect(readdirSync(cache).filter((name) => /^[a-f0-9]{64}$/.test(name))).toEqual([]);
  });
  it('blocks npm prefix redirection before central installation', () => {
    const f = fixture();
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/private': { version: '2.0.0' } },
      }),
    );
    writeFileSync(join(f.root, 'bin', '.npm-prefix-redirect'), 'redirect');
    const result = f.run('install');
    expect(result.status).toBe(1);
    expect(existsSync(f.called)).toBe(false);
    expect(existsSync(join(f.worktree, 'node_modules', '.verity-install.json'))).toBe(false);
  });
  it('resolves a relative user configuration before central preparation', () => {
    const f = fixture();
    writeFileSync(join(f.worktree, 'user.npmrc'), 'engine-strict=true\n');
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/private': { version: '2.0.0' } },
      }),
    );
    const result = f.run('install', {
      NPM_CONFIG_USERCONFIG: 'user.npmrc',
      TEST_EXPECTED_USERCONFIG_CONTENT: 'engine-strict=true\n',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(f.run('status', { NPM_CONFIG_USERCONFIG: 'user.npmrc' }).status).toBe(0);
    expect(readFileSync(f.called, 'utf8').match(/\nci\n/g)).toHaveLength(1);
  });
  it('preserves a relative certificate path during central preparation', () => {
    const f = fixture();
    mkdirSync(join(f.worktree, 'certs'));
    const certificate = join(f.worktree, 'certs', 'registry.pem');
    writeFileSync(certificate, 'certificate');
    writeFileSync(join(f.worktree, '.npmrc'), 'cafile=certs/registry.pem\n');
    const result = f.run('install', { TEST_EXPECTED_CAFILE: certificate });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(f.called, 'utf8').match(/\nci\n/g)).toHaveLength(1);
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
    expect(f.run('status').status).toBe(1);
    expect(f.run('install').status).toBe(0);
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
  it('rejects unprepared npm v1 locks without a private installation fallback', () => {
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
    expect(f.run('status').status).toBe(1);
    expect(f.run('install').status).toBe(1);
    expect(existsSync(f.called)).toBe(false);
    expect(f.run('status').status).toBe(1);
  });
  it.each([false, true])('recognizes pnpm 12 project locks (boot document: %s)', (boot) => {
    const f = fixture();
    writeFileSync(join(f.worktree, 'package.json'), '{"packageManager":"pnpm@12.3.4"}');
    const project =
      "lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      dep:\n        specifier: ^1.0.0\n        version: 1.0.0\n";
    const prefix = boot
      ? "---\nlockfileVersion: '9.0'\nimporters:\n  .:\n    packageManagerDependencies:\n      pnpm:\n        specifier: 12.3.4\n        version: 12.3.4\n---\n"
      : '';
    writeFileSync(join(f.worktree, 'pnpm-lock.yaml'), prefix + project);
    const store = join(f.worktree, 'node_modules', '.pnpm');
    mkdirSync(store, { recursive: true });
    writeFileSync(join(f.worktree, 'node_modules', '.modules.yaml'), 'layoutVersion: 5');
    const current = join(store, 'lock.yaml');
    writeFileSync(current, project);
    expect(f.run('status').status).toBe(0);
    expect(f.run('install').status).toBe(0);
    expect(existsSync(f.called)).toBe(false);
    writeFileSync(current, project.replace('version: 1.0.0', 'version: 0.9.0'));
    expect(f.run('status').status).toBe(1);
    expect(f.run('install').status).toBe(1);
    rmSync(current);
    expect(f.run('status').status).toBe(1);
    expect(existsSync(f.called)).toBe(false);
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
    expect(f.run('status').status).toBe(1);
    expect(f.run('install').status).toBe(0);
    expect(f.run('status').status).toBe(0);
  });
  it('rejects preparation of local npm links outside the checkout', () => {
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
    expect(f.run('status').status).toBe(1);
    expect(f.run('install').status).toBe(1);
    expect(existsSync(f.called)).toBe(false);
    expect(realpathSync(join(f.worktree, 'node_modules', 'shared'))).toBe(target);
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
  it('preserves stale workspace dependency trees before activating hoisted packages', () => {
    const f = fixture();
    const workspace = join(f.worktree, 'packages', 'source');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'package.json'), '{"name":"source"}');
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'packages/source': { name: 'source' },
          'node_modules/source': { link: true, resolved: 'packages/source' },
          'node_modules/private': { version: '2.0.0' },
        },
      }),
    );
    expect(f.run('install').status).toBe(0);
    // A valid root receipt must not conceal a stale workspace resolution path.
    mkdirSync(join(workspace, 'node_modules', 'private'), { recursive: true });
    writeFileSync(
      join(workspace, 'node_modules', 'private', 'package.json'),
      '{"version":"1.0.0"}',
    );
    writeFileSync(join(workspace, 'node_modules', 'patch.txt'), 'keep workspace patch');
    expect(f.run('status').status).toBe(1);
    const activated = f.run('install');
    expect(activated.status, activated.stderr).toBe(0);
    expect(existsSync(join(workspace, 'node_modules'))).toBe(false);
    const loaded = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { createRequire } from 'node:module'; console.log(createRequire(process.cwd() + '/probe.js')('private/package.json').version);",
      ],
      { cwd: workspace, encoding: 'utf8' },
    );
    expect(loaded.trim()).toBe('2.0.0');
    const preserved = join(f.root, '.git', 'worktrees', 'test', 'verity-dependencies-preserved');
    expect(
      readdirSync(preserved).some(
        (entry) =>
          existsSync(join(preserved, entry, 'patch.txt')) &&
          readFileSync(join(preserved, entry, 'patch.txt'), 'utf8') === 'keep workspace patch',
      ),
    ).toBe(true);
    expect(readFileSync(f.called, 'utf8').match(/\nci\n/g)).toHaveLength(1);
    expect(f.run('status').status).toBe(0);
  });
  it('restores workspace command links to each receiving session', () => {
    const f = fixture();
    const sibling = f.sibling();
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/source': { link: true, resolved: 'packages/source' } },
    });
    for (const [directory, output] of [
      [f.worktree, 'first'],
      [sibling, 'second'],
    ] as const) {
      mkdirSync(join(directory, 'packages', 'source'), { recursive: true });
      writeFileSync(
        join(directory, 'packages', 'source', 'package.json'),
        JSON.stringify({ name: 'source', bin: { 'workspace-cli': 'cli.js' } }),
      );
      writeFileSync(
        join(directory, 'packages', 'source', 'cli.js'),
        `#!${process.execPath}${output === 'second' ? '\r\n' : '\n'}console.log(${JSON.stringify(output)});\n`,
        { mode: 0o644 },
      );
      chmodSync(join(directory, 'packages', 'source', 'cli.js'), 0o644);
      writeFileSync(join(directory, 'package-lock.json'), lock);
    }
    expect(f.run('install').status).toBe(0);
    const second = spawnSync(process.execPath, [helper, 'install'], {
      cwd: sibling,
      env: { ...env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    expect(second.status, second.stderr).toBe(0);
    for (const [directory, output] of [
      [f.worktree, 'first'],
      [sibling, 'second'],
    ] as const) {
      const command = join(directory, 'node_modules', '.bin', 'workspace-cli');
      expect(realpathSync(command)).toBe(join(directory, 'packages', 'source', 'cli.js'));
      const result = spawnSync(command, [], { cwd: directory, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(output);
    }
    expect(readFileSync(f.called, 'utf8').match(/\nci\n/g)).toHaveLength(1);
  });
  it('rejects workspace commands that link to executable sources outside the session', () => {
    const f = fixture();
    const external = join(f.root, 'bin', 'external-cli.js');
    const source = `#!${process.execPath}\r\nconsole.log('external');\n`;
    writeFileSync(external, source, { mode: 0o644 });
    chmodSync(external, 0o644);
    mkdirSync(join(f.worktree, 'packages', 'source'), { recursive: true });
    writeFileSync(
      join(f.worktree, 'packages', 'source', 'package.json'),
      JSON.stringify({ name: 'source', bin: { 'external-cli': 'cli.js' } }),
    );
    symlinkSync(external, join(f.worktree, 'packages', 'source', 'cli.js'));
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/source': { link: true, resolved: 'packages/source' } },
      }),
    );
    const result = f.run('install');
    expect(result.status).toBe(1);
    expect(readFileSync(external, 'utf8')).toBe(source);
    expect(statSync(external).mode & 0o777).toBe(0o644);
    expect(existsSync(join(f.worktree, 'node_modules', '.verity-install.json'))).toBe(false);
  });
  it('keeps failed central preparations inactive and preserves session patches on retry', () => {
    const f = fixture();
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/private': { version: '2.0.0' } },
      }),
    );
    mkdirSync(join(f.worktree, 'node_modules'));
    writeFileSync(join(f.worktree, 'node_modules', 'patch.txt'), 'keep');
    writeFileSync(join(f.root, 'bin', '.npm-fail'), 'fail');
    const failed = f.run('install');
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('failed (42)');
    expect(f.run('status').status).toBe(1);
    expect(readFileSync(join(f.worktree, 'node_modules', 'patch.txt'), 'utf8')).toBe('keep');
    expect(existsSync(join(f.worktree, 'node_modules', '.verity-install.json'))).toBe(false);
    rmSync(join(f.root, 'bin', '.npm-fail'));
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
      writeFileSync(join(f.root, 'bin', '.npm-delay'), '500');
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
  it('reports a shared preparation failure to waiting sessions without repeated installation', async () => {
    const f = fixture();
    const sibling = f.sibling();
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/private': { version: '2.0.0' } },
    });
    for (const directory of [f.worktree, sibling])
      writeFileSync(join(directory, 'package-lock.json'), lock);
    writeFileSync(join(f.root, 'bin', '.npm-delay'), '1000');
    writeFileSync(join(f.root, 'bin', '.npm-fail'), 'fail');
    const first = f.start();
    const second = f.start(sibling);
    const results = await Promise.all(
      [first, second].map(
        (child) =>
          new Promise<number | null>((done, reject) => {
            child.on('error', reject);
            child.on('close', done);
          }),
      ),
    );
    expect(results).toEqual([1, 1]);
    expect(readFileSync(f.called, 'utf8').match(/\nci\n/g)).toHaveLength(1);
    for (const directory of [f.worktree, sibling])
      expect(existsSync(join(directory, 'node_modules', '.verity-install.json'))).toBe(false);
    rmSync(join(f.root, 'bin', '.npm-delay'));
    rmSync(join(f.root, 'bin', '.npm-fail'));
    expect(f.run('install').status).toBe(0);
    expect(readFileSync(f.called, 'utf8').match(/\nci\n/g)).toHaveLength(2);
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
    writeFileSync(join(f.root, 'bin', '.npm-delay'), '10000');
    const child = f.start();
    const exited = new Promise((done, reject) => {
      child.on('error', reject);
      child.on('close', done);
    });
    const deadline = Date.now() + 60000;
    while (!existsSync(f.called) && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 25));
    expect(existsSync(f.called)).toBe(true);
    child.kill('SIGTERM');
    expect(await exited).toBe(143);
    expect(f.run('status').status).toBe(1);
    rmSync(join(f.root, 'bin', '.npm-delay'));
    expect(f.run('install').status).toBe(0);
  });
  it('keeps central preparation locked when the helper is killed before native npm exits', async () => {
    const f = fixture();
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/private': { version: '2.0.0' } },
      }),
    );
    writeFileSync(join(f.root, 'bin', '.npm-delay'), '2000');
    const child = f.start();
    const exited = new Promise((done) => child.on('exit', done));
    const drained = new Promise((done) => child.on('close', done));
    const deadline = Date.now() + 60000;
    while (!existsSync(f.called) && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 25));
    expect(existsSync(f.called)).toBe(true);
    child.kill('SIGKILL');
    await exited;
    try {
      const lock = join(f.root, '.git', 'verity-dependencies', 'preparation.lock');
      expect(spawnSync('flock', ['-n', lock, 'true']).status).toBe(1);
    } finally {
      await drained;
    }
    expect(f.run('status').status).toBe(1);
    const cache = join(f.root, '.git', 'verity-dependencies');
    const staging = readdirSync(cache).find((name) => /^[a-f0-9]{64}\.prepare$/u.test(name));
    expect(staging).toBeDefined();
    writeFileSync(join(cache, staging!, 'stale.txt'), 'interrupted preparation');
    rmSync(join(f.root, 'bin', '.npm-delay'));
    expect(f.run('install').status).toBe(0);
    expect(f.run('status').status).toBe(0);
    expect(existsSync(join(cache, staging!))).toBe(false);
    const completed = join(cache, staging!.replace(/\.prepare$/u, ''));
    expect(existsSync(join(completed, 'stale.txt'))).toBe(false);
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
    writeFileSync(
      join(f.root, 'bin', '.npm-required-source'),
      JSON.stringify({ 'vendor/local/index.js': 'export default 1;' }),
    );
    expect(f.run('install').status).toBe(0);
    expect(f.run('status').status).toBe(0);
    writeFileSync(join(f.worktree, 'vendor', 'local', 'index.js'), 'export default 2;');
    writeFileSync(
      join(f.root, 'bin', '.npm-required-source'),
      JSON.stringify({ 'vendor/local/index.js': 'export default 2;' }),
    );
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
  it('repairs its corrupt packed-source snapshot while another identity is active', () => {
    const f = fixture();
    const cache = join(f.root, '.git', 'verity-dependencies');
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/private': { version: '1.0.0' } },
      }),
    );
    expect(f.run('install').status).toBe(0);
    const first = readdirSync(cache).find((name) => /^[a-f0-9]{64}$/u.test(name))!;
    mkdirSync(join(f.worktree, 'vendor', 'local'), { recursive: true });
    writeFileSync(
      join(f.worktree, 'vendor', 'local', 'package.json'),
      '{"name":"local","version":"1.0.0"}',
    );
    writeFileSync(join(f.worktree, 'vendor', 'local', 'index.js'), 'export default 1;');
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/local': { version: '1.0.0', resolved: 'file:vendor/local' } },
      }),
    );
    expect(f.run('install').status).toBe(0);
    const current = readdirSync(cache).find(
      (name) => /^[a-f0-9]{64}$/u.test(name) && name !== first,
    )!;
    writeFileSync(join(cache, current, 'vendor', 'local', 'index.js'), 'corrupt cached source');
    rmSync(join(f.worktree, 'node_modules'), { recursive: true });
    const fd = openSync(join(cache, first + '.lock'), 'a');
    try {
      expect(
        spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] }).status,
      ).toBe(0);
      const result = f.run('install');
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(cache, first))).toBe(true);
      expect(readFileSync(join(cache, current, 'vendor', 'local', 'index.js'), 'utf8')).toBe(
        'export default 1;',
      );
      expect(f.run('status').status).toBe(0);
      expect(readFileSync(f.called, 'utf8').match(/\nci\n/g)).toHaveLength(3);
    } finally {
      closeSync(fd);
    }
  });
  it('requires managed proof for complete legacy inventories after configuration or runtime changes', () => {
    const f = fixture();
    const receipt = readFileSync(join(f.root, 'node_modules', '.verity-install.json'), 'utf8');
    rmSync(join(f.root, 'node_modules', '.verity-install.json'));
    mkdirSync(join(f.worktree, 'node_modules'));
    writeFileSync(join(f.worktree, 'node_modules', '.package-lock.json'), '{"packages":{}}');
    expect(f.run('status').status).toBe(1);
    expect(f.run('status', { npm_config_install_links: 'true' }).status).toBe(1);
    const preload = join(f.root, 'bin', 'legacy-libc.mjs');
    writeFileSync(
      preload,
      "process.report.getReport = () => ({header:{glibcVersionRuntime:'different-libc'}});\n",
    );
    expect(
      f.run('status', { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preload}` })
        .status,
    ).toBe(1);
    writeFileSync(join(f.root, 'node_modules', '.verity-install.json'), receipt);
    expect(f.run('status').status).toBe(1);
    expect(f.run('install').status).toBe(0);
    expect(f.run('status').status).toBe(0);
  });
  it('invalidates managed receipts when the effective default global npm configuration changes', () => {
    const f = fixture();
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/private': { version: '1.0.0' } },
      }),
    );
    expect(f.run('install').status).toBe(0);
    expect(f.run('status').status).toBe(0);
    writeFileSync(join(f.root, 'bin', 'globalconfig.npmrc'), 'install-links=true\n');
    expect(f.run('status').status).toBe(1);
    expect(f.run('install').status).toBe(0);
    expect(readFileSync(f.called, 'utf8').match(/\nci\n/g)).toHaveLength(2);
  });
  it('freezes identity after managed policy setup and reuses the completed installation', () => {
    const f = fixture();
    const trusted = join(f.root, 'bin', 'trusted-policy');
    mkdirSync(trusted);
    writeFileSync(
      join(trusted, 'verity-npm-preflight.mjs'),
      "export const npmStateDirectory = (root) => root + '/.cache';\n",
    );
    writeFileSync(
      join(trusted, 'verity-package-install.mjs'),
      `import fs from 'node:fs';
if (process.argv.slice(2).join(' ') === 'npm --verity-prepare-only') { fs.appendFileSync('policy-prepared','prepare\\n'); fs.writeFileSync('.npmrc','min-release-age=3\\n'); }
else if (process.argv.slice(2).join(' ') !== 'npm ci --verity-verify-only') process.exit(2);
`,
    );
    const instrumented = join(f.root, 'bin', 'helper.mjs');
    writeFileSync(
      instrumented,
      readFileSync(helper, 'utf8').replace(
        "const directory = '/usr/local/lib/verity';",
        `const directory = ${JSON.stringify(trusted)};`,
      ),
    );
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/private': { version: '1.0.0' } },
      }),
    );
    const run = (action: string) =>
      spawnSync(process.execPath, [instrumented, action], {
        cwd: f.worktree,
        env: {
          ...env,
          PATH: `${join(f.root, 'bin')}:${process.env.PATH}`,
          VERITY_SESSION_ID: 'fixture-session',
        },
        encoding: 'utf8',
      });
    const installed = run('install');
    expect(installed.status, installed.stderr).toBe(0);
    expect(run('status').status).toBe(0);
    expect(run('install').status).toBe(0);
    expect(readFileSync(join(f.worktree, 'policy-prepared'), 'utf8')).toBe('prepare\n');
    expect(readFileSync(f.called, 'utf8').match(/\nci\n/g)).toHaveLength(1);
  });
  it.each(['missing', 'legacy'])(
    'blocks central preparation with a %s staging-aware runtime verifier',
    (variant) => {
      const f = fixture();
      const trusted = join(f.root, 'bin', 'legacy-policy');
      mkdirSync(trusted);
      writeFileSync(
        join(trusted, 'verity-npm-preflight.mjs'),
        variant === 'missing'
          ? '// no staging support'
          : "export const npmStateDirectory = () => '/legacy/git/state';\n",
      );
      writeFileSync(join(trusted, 'verity-package-install.mjs'), '// permits preparation');
      const instrumented = join(f.root, 'bin', 'legacy-helper.mjs');
      writeFileSync(
        instrumented,
        readFileSync(helper, 'utf8').replace(
          "const directory = '/usr/local/lib/verity';",
          `const directory = ${JSON.stringify(trusted)};`,
        ),
      );
      writeFileSync(
        join(f.worktree, 'package-lock.json'),
        JSON.stringify({
          lockfileVersion: 3,
          packages: { 'node_modules/private': { version: '2.0.0' } },
        }),
      );
      const result = spawnSync(process.execPath, [instrumented, 'install'], {
        cwd: f.worktree,
        env: {
          ...env,
          PATH: `${join(f.root, 'bin')}:${process.env.PATH}`,
          VERITY_SESSION_ID: 'fixture-session',
        },
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(existsSync(f.called)).toBe(false);
      expect(existsSync(join(f.worktree, 'node_modules', '.verity-install.json'))).toBe(false);
    },
  );
  it('keeps policy verification mandatory when reusing a prepared installation', () => {
    const f = fixture();
    const trusted = join(f.root, 'bin', 'rejecting-policy');
    mkdirSync(trusted);
    writeFileSync(
      join(trusted, 'verity-npm-preflight.mjs'),
      "export const npmStateDirectory = (root) => root + '/.cache';\n",
    );
    writeFileSync(
      join(trusted, 'verity-package-install.mjs'),
      "if (process.env.TEST_POLICY_REJECT === '1') process.exit(47);\n",
    );
    const instrumented = join(f.root, 'bin', 'policy-helper.mjs');
    writeFileSync(
      instrumented,
      readFileSync(helper, 'utf8').replace(
        "const directory = '/usr/local/lib/verity';",
        `const directory = ${JSON.stringify(trusted)};`,
      ),
    );
    const result = spawnSync(process.execPath, [instrumented, 'install'], {
      cwd: f.worktree,
      env: {
        ...env,
        PATH: `${join(f.root, 'bin')}:${process.env.PATH}`,
        VERITY_SESSION_ID: 'fixture-session',
        TEST_POLICY_REJECT: '1',
      },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Reused dependency age verification failed');
    expect(existsSync(f.called)).toBe(false);
  });
  it('still rejects an unexpected npm configuration change during native installation', () => {
    const f = fixture();
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/private': { version: '1.0.0' } },
      }),
    );
    writeFileSync(join(f.root, 'bin', '.npm-change-config'), 'change');
    const result = f.run('install');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Dependency inputs changed during installation');
    expect(existsSync(join(f.worktree, 'node_modules', '.verity-install.json'))).toBe(false);
  });
  it('ships identical executable helpers in both seed trees', () => {
    expect(readFileSync(helper, 'utf8')).toBe(
      readFileSync('features/verity-sandbox-toolkit/agent-seed/bin/verity-dependencies', 'utf8'),
    );
  });
});
