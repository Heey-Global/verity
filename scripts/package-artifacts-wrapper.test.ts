import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function configure(
  manager: string,
  args: string[] = ['install', '--', 'a'],
  installToken?: string,
) {
  const root = mkdtempSync(resolve('.cache/package-artifacts-'));
  roots.push(root);
  const token = join(root, 'capability');
  const original = join(root, 'original.npmrc');
  writeFileSync(token, 'fixture-capability');
  writeFileSync(original, 'min-release-age=4320\nstrict-ssl=true\n');
  const env = {
    HOME: root,
    VERITY_PACKAGE_ARTIFACT_URL: 'http://relay:8080/internal/package-artifacts',
    VERITY_PROJECT_MEMORY_URL: 'http://relay:8080/internal/project/memory',
    VERITY_GH_BROKER_CAPABILITY_FILE: token,
    NPM_CONFIG_USERCONFIG: original,
    ...(installToken ? { VERITY_PACKAGE_INSTALL_TOKEN: installToken } : {}),
  };
  const source = `import { configurePackageArtifacts } from ${JSON.stringify(pathToFileURL(resolve('features/verity-sandbox-toolkit/bin/verity-package-artifacts.mjs')).href)};
import {readFileSync, existsSync} from 'node:fs';
const env=${JSON.stringify(env)};
const configured=configurePackageArtifacts(${JSON.stringify(manager)},${JSON.stringify(args)},env);
const config=env.npm_config_userconfig ? readFileSync(env.npm_config_userconfig,'utf8') : undefined;
const path=env.npm_config_userconfig;
configured.cleanup();
console.log(JSON.stringify({env,args:configured.args,config,path,remaining:path ? existsSync(path) : false}));`;
  const result = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' }),
  ) as {
    env: Record<string, string>;
    args: string[];
    config?: string;
    path?: string;
    remaining: boolean;
  };
  return { ...result, original };
}

it.each(['npm', 'pnpm', 'bun'])(
  'routes %s through the scoped broker without changing durable config',
  (manager) => {
    const result = configure(manager);
    expect(result.args).toEqual([
      'install',
      '--registry=http://relay:8080/internal/package-artifacts/npm/',
      ...(manager === 'npm' ? [`--userconfig=${result.path}`] : []),
      '--',
      'a',
    ]);
    expect(result.config).toContain('min-release-age=4320\nstrict-ssl=true');
    expect(result.config).toContain(
      '//relay:8080/internal/package-artifacts/:_authToken=fixture-capability',
    );
    expect(result.env.NPM_CONFIG_USERCONFIG).toBe(result.env.npm_config_userconfig);
    expect(result.remaining).toBe(false);
    expect(existsSync(result.path!)).toBe(false);
    expect(readFileSync(result.original, 'utf8')).toBe('min-release-age=4320\nstrict-ssl=true\n');
  },
);
it.each(['pip', 'uv'])(
  'selects an authenticated %s index without replacing pip config',
  (manager) => {
    const result = configure(manager);
    const key = manager === 'pip' ? 'PIP_INDEX_URL' : 'UV_DEFAULT_INDEX';
    expect(result.env[key]).toBe(
      'http://verity:fixture-capability@relay:8080/internal/package-artifacts/pypi/simple/',
    );
    expect(result.env.PIP_EXTRA_INDEX_URL).toBe('');
    expect(result.env.PIP_CONFIG_FILE).toBeUndefined();
    expect(result.config).toBeUndefined();
  },
);
it.each(['npm', 'pnpm', 'bun'])('does not forward registry flags to %s scripts', (manager) => {
  for (const args of [['run', 'build'], ['test'], ['run', 'test', '--', '--watch']])
    expect(configure(manager, args).args).toEqual(args);
});
it('configures Yarn registry reads with no install-script bypass', () => {
  const result = configure('yarn');
  expect(result.env.YARN_NPM_REGISTRY_SERVER).toBe(
    'http://relay:8080/internal/package-artifacts/npm/',
  );
  expect(result.args).toEqual(['install', '--', 'a']);
  expect(result.env.npm_config_ignore_scripts).toBeUndefined();
});

it('uses an ephemeral installation token instead of widening the project capability', () => {
  const result = configure('npm', ['ci'], 'one-install-token');
  expect(result.config).toContain(':_authToken=one-install-token');
  expect(result.config).not.toContain(':_authToken=fixture-capability');
  expect(readFileSync(result.original, 'utf8')).not.toContain('one-install-token');
  expect(result.remaining).toBe(false);
});

it('keeps the managed registry and credentials effective with npm prefix and config flags', () => {
  const result = configure('npm', [
    '--prefix',
    'web',
    'install',
    '--registry=https://other.test',
    '--userconfig=custom.npmrc',
  ]);
  expect(result.args.at(-2)).toBe('--registry=http://relay:8080/internal/package-artifacts/npm/');
  expect(result.args.at(-1)).toBe(`--userconfig=${result.path}`);
  expect(result.config).toContain(':_authToken=fixture-capability');
});
