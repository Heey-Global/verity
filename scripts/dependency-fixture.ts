// Shared fixture for the verity-dependencies helper suites: a Git project with a
// session worktree, a fake npm and one genuinely prepared central inventory.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach } from 'vitest';

export const helper = resolve('agent-seed/bin/verity-dependencies');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
export const env = {
  ...process.env,
  VERITY_SESSION_ID: '',
  // npm test exports its own configuration paths; the fake npm must use the
  // fixture's global configuration so drift assertions exercise that file.
  NPM_CONFIG_GLOBALCONFIG: undefined,
  npm_config_globalconfig: undefined,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
export function fixture() {
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
    if (!file.startsWith('node_modules/') && !file.includes('/node_modules/')) continue;
    if (value.link) {
      fs.mkdirSync(path.dirname(file), {recursive:true});
      fs.symlinkSync(path.relative(path.dirname(file), value.resolved), file);
    } else {
      fs.mkdirSync(file, {recursive:true});
      fs.writeFileSync(path.join(file, 'package.json'), JSON.stringify({version:value.version}));
      if (file === 'node_modules/private') {
        fs.writeFileSync(path.join(file,'cli.js'),'// private cli');
        fs.chmodSync(path.join(file,'cli.js'),0o755);
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
  const run = (action: string, extraEnv: NodeJS.ProcessEnv = {}, ...args: string[]) =>
    spawnSync(process.execPath, [helper, action, ...args], {
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
