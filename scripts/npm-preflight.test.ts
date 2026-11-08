import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import {
  npmInstallPlan,
  npmLockedPackages,
  npmProjectRoot,
  preserveNpmDependencies,
} from '../features/verity-sandbox-toolkit/bin/verity-npm-preflight.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(lock: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'npm-preflight-'));
  roots.push(root);
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock));
  return root;
}

it('freezes the resolved tree and preserves install scope and lifecycle settings', () => {
  const args = [
    '--prefix',
    '/project',
    'install',
    'example@1.0.0',
    '--save-dev',
    '--ignore-scripts',
    '--workspace=web',
  ];
  const plan = npmInstallPlan(args, '/project');
  expect(plan.resolveArgs).toEqual([
    ...args,
    '--package-lock-only=true',
    '--package-lock=true',
    '--ignore-scripts=true',
    '--audit=false',
  ]);
  expect(plan.installArgs).toEqual([
    'ci',
    '--prefix',
    '/project',
    '--ignore-scripts',
    '--workspace=web',
  ]);
});

it.each([
  ['exec', 'example'],
  ['audit', 'fix'],
  ['install', '-g'],
  ['install', '--global=true'],
  ['install', '-gD'],
  ['install', '--location', 'global'],
  ['install', '--no-save'],
])('fails closed for unfreezable npm invocation %j', (...args) => {
  expect(() => npmInstallPlan(args, '/project')).toThrow();
});

it('does not turn a lockfile-only request into an installation', () => {
  expect(
    npmInstallPlan(['install', '--package-lock-only'], '/project').installArgs,
  ).toBeUndefined();
  expect(npmInstallPlan(['ci'], '/project').resolveArgs).toBeUndefined();
  expect(npmInstallPlan(['clean-install'], '/project').installArgs).toEqual(['ci']);
  expect(npmInstallPlan(['ic'], '/project').installArgs).toEqual(['ci']);
});

it('includes nested, optional, alias and cached registry versions while excluding local links', () => {
  const root = fixture({
    lockfileVersion: 3,
    packages: {
      '': { version: '1.0.0' },
      'node_modules/a': { version: '1.2.3' },
      'node_modules/a/node_modules/b': { version: '2.0.0', optional: true },
      'node_modules/alias': { name: '@scope/original', version: '3.0.0' },
      'node_modules/c': { version: '4.0.0', resolved: 'file:vendor/c' },
      'node_modules/workspace': { link: true, resolved: 'packages/workspace' },
    },
  });
  mkdirSync(join(root, 'packages', 'workspace'), { recursive: true });
  expect(npmLockedPackages(root).packages).toEqual([
    { name: 'a', version: '1.2.3' },
    { name: 'b', version: '2.0.0' },
    { name: '@scope/original', version: '3.0.0' },
  ]);
  expect(npmInstallPlan(['ci'], join(root, 'packages', 'workspace')).root).toBe(
    join(root, 'packages', 'workspace'),
  );
});

it('uses the native npm root instead of trusting an ancestor lockfile', () => {
  const root = fixture({ lockfileVersion: 3, packages: {} });
  const nested = join(root, 'nested');
  mkdirSync(nested);
  writeFileSync(join(nested, 'package.json'), '{"name":"independent"}');
  const executable = join(root, 'npm');
  writeFileSync(executable, `#!${process.execPath}\nconsole.log(${JSON.stringify(nested)});\n`, {
    mode: 0o755,
  });
  expect(npmProjectRoot(executable, nested, process.env, ['install'])).toBe(nested);
});

it('preserves root and workspace packages before frozen ci can remove local patches', () => {
  const root = fixture({ lockfileVersion: 3, packages: { '': {}, 'packages/web': {} } });
  for (const directory of [root, join(root, 'packages', 'web')]) {
    mkdirSync(join(directory, 'node_modules', 'patched'), { recursive: true });
    writeFileSync(join(directory, 'node_modules', 'patched', 'local.js'), 'local patch');
  }
  const recovery = preserveNpmDependencies(root)!;
  roots.push(recovery);
  const paths = JSON.parse(readFileSync(join(recovery, 'paths.json'), 'utf8')) as {
    source: string;
    target: string;
  }[];
  expect(paths).toHaveLength(2);
  for (const path of paths) {
    expect(existsSync(path.source)).toBe(false);
    expect(readFileSync(join(path.target, 'patched', 'local.js'), 'utf8')).toBe('local patch');
  }
});

it('deduplicates registry versions in legacy nested lockfiles', () => {
  const root = fixture({
    lockfileVersion: 1,
    dependencies: {
      a: { version: '1.2.3', dependencies: { a: { version: '1.2.3' }, b: { version: '1.0.0' } } },
    },
  });
  expect(npmLockedPackages(root).packages).toEqual([
    { name: 'a', version: '1.2.3' },
    { name: 'b', version: '1.0.0' },
  ]);
});

it.each(['git+https://example.test/a.git', 'https://example.test/a.tgz'])(
  'does not invent registry publication dates for %s',
  (resolved) => {
    const root = fixture({
      lockfileVersion: 3,
      packages: { 'node_modules/a': { version: '1.2.3', resolved } },
    });
    expect(() => npmLockedPackages(root)).toThrow('unsupported source');
  },
);
