import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const temporary: string[] = [];
afterEach(() =>
  temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);

function fixture(failPatch = false) {
  const root = mkdtempSync(join(tmpdir(), 'verity-eas-'));
  temporary.push(root);
  for (const dir of ['scripts', 'apps/mobile', 'bin'])
    mkdirSync(join(root, dir), { recursive: true });
  const app = JSON.parse(readFileSync('apps/mobile/package.json', 'utf8'));
  // Resolve the shipped lifecycle command: a helper-only test misses an unwired hook.
  const hook = app.scripts.postinstall as string;
  expect(hook).toMatch(/^node \.\.\/\.\.\/scripts\/[^ ]+\.mjs$/);
  const entry = resolve(root, 'apps/mobile', hook.slice('node '.length));
  copyFileSync(resolve('apps/mobile', hook.slice('node '.length)), entry);
  writeFileSync(
    join(root, 'scripts/patch-mobile-native-deps.mjs'),
    `
    import { appendFileSync } from 'node:fs';
    appendFileSync(process.env.TRACE, 'patch:' + process.cwd() + '\\n');
    process.exit(${failPatch ? 7 : 0});
  `,
  );
  writeFileSync(
    join(root, 'bin/npm'),
    `#!${process.execPath}\n
    require('node:fs').appendFileSync(process.env.TRACE,
      JSON.stringify({args: process.argv.slice(2), cwd: process.cwd()}) + '\\n');
  `,
  );
  chmodSync(join(root, 'bin/npm'), 0o755);
  writeFileSync(join(root, 'apps/mobile/package.json'), JSON.stringify(app));
  const trace = join(root, 'trace');
  return {
    root,
    run(eas: string, verify = false, profile = 'development') {
      return spawnSync(process.execPath, [entry, ...(verify ? ['--verify'] : [])], {
        cwd: join(root, 'apps/mobile'),
        env: {
          ...process.env,
          EAS_BUILD: eas,
          EAS_BUILD_PROFILE: profile,
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
          TRACE: trace,
        },
        encoding: 'utf8',
      });
    },
    trace: () => readFileSync(trace, 'utf8').trim().split('\n'),
  };
}

describe('EAS archive preparation', () => {
  it('patches the isolated install before building the shared workspace', () => {
    const f = fixture();
    expect(f.run('true').status).toBe(0);
    const lines = f.trace();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`patch:${f.root}`);
    expect(JSON.parse(lines[1]!)).toEqual({
      args: ['run', '--workspace', '@verity/mobile', 'build'],
      cwd: f.root,
    });
  });

  it('excludes development pods only from the isolated TestFlight manifest', () => {
    const f = fixture();
    const path = join(f.root, 'apps/mobile/package.json');
    const app = JSON.parse(readFileSync(path, 'utf8'));
    app.expo = { autolinking: { ios: { exclude: ['existing-module'] } } };
    writeFileSync(path, JSON.stringify(app));
    expect(f.run('true', false, 'testflight').status).toBe(0);
    const prepared = JSON.parse(readFileSync(path, 'utf8'));
    expect(prepared.expo.autolinking.ios.exclude).toEqual([
      'existing-module',
      'expo-dev-client',
      'expo-dev-menu',
      'expo-dev-launcher',
    ]);
    expect(prepared.dependencies).toEqual(app.dependencies);
    expect(f.run('true', false, 'testflight').status).toBe(0);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(prepared);
  });

  it.each(['development', 'preview', 'production', 'simulator'])(
    'preserves the manifest for the %s profile',
    (profile) => {
      const f = fixture();
      const path = join(f.root, 'apps/mobile/package.json');
      const original = readFileSync(path, 'utf8');
      expect(f.run('true', false, profile).status).toBe(0);
      expect(readFileSync(path, 'utf8')).toBe(original);
    },
  );

  it('runs the shipped workspace lifecycle during an isolated npm ci', () => {
    const f = fixture();
    mkdirSync(join(f.root, 'packages/mobile'), { recursive: true });
    const app = JSON.parse(readFileSync('apps/mobile/package.json', 'utf8'));
    writeFileSync(
      join(f.root, 'package.json'),
      JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }),
    );
    writeFileSync(
      join(f.root, 'apps/mobile/package.json'),
      JSON.stringify({
        name: '@verity/mobile-app',
        version: '0.0.0',
        scripts: { postinstall: app.scripts.postinstall },
      }),
    );
    writeFileSync(
      join(f.root, 'packages/mobile/package.json'),
      JSON.stringify({
        name: '@verity/mobile',
        version: '0.0.0',
        scripts: { build: 'node build.cjs' },
      }),
    );
    writeFileSync(
      join(f.root, 'packages/mobile/build.cjs'),
      "require('node:fs').appendFileSync(process.env.TRACE, 'build\\n');",
    );
    const options = {
      cwd: f.root,
      env: { ...process.env, EAS_BUILD: 'true', TRACE: join(f.root, 'trace') },
      encoding: 'utf8' as const,
    };
    const lock = spawnSync(
      'npm',
      [
        'install',
        '--package-lock-only',
        '--ignore-scripts',
        '--offline',
        '--no-audit',
        '--no-fund',
      ],
      options,
    );
    expect(lock.status, lock.stderr).toBe(0);
    const install = spawnSync(
      'npm',
      ['ci', '--ignore-scripts=false', '--offline', '--no-audit', '--no-fund'],
      options,
    );
    expect(install.status, install.stderr).toBe(0);
    expect(f.trace()).toEqual([`patch:${f.root}`, 'build']);
  });

  it('fails closed before workspace preparation when a native patch fails', () => {
    const f = fixture(true);
    expect(f.run('true').status).not.toBe(0);
    expect(f.trace()).toEqual([`patch:${f.root}`]);
  });

  it('refuses compilation if the install lifecycle was skipped', () => {
    const f = fixture();
    const app = JSON.parse(readFileSync('apps/mobile/package.json', 'utf8'));
    expect(app.scripts['eas-build-post-install']).toBe(`${app.scripts.postinstall} --verify`);
    expect(f.run('true', true).status).not.toBe(0);
    expect(f.run('true').status).toBe(0);
    expect(f.run('true', true).status).toBe(0);
    writeFileSync(join(f.root, '.verity-eas-prepared'), '/another/build/');
    expect(f.run('true', true).status).not.toBe(0);
    expect(readFileSync('.easignore', 'utf8').split('\n')).toContain('.verity-eas-prepared');
  });

  it('does not run build preparation during an ordinary install', () => {
    const f = fixture(true);
    expect(f.run('false').status).toBe(0);
    expect(() => f.trace()).toThrow();
  });

  it('keeps the cache bounded, strict and confined to compiler objects', () => {
    const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8'));
    const steps = workflow.jobs['publish-mobile-native'].steps as {
      id?: string;
      name?: string;
      run: string;
      if: string;
      with: Record<string, string>;
    }[];
    const setup = steps.find((s: { id?: string }) => s.id === 'compiler-cache');
    const cache = steps.find((s: { name?: string }) => s.name === 'Restore native compiler cache');
    expect(cache!.with.path).toBe('${{ runner.temp }}/verity-mobile-ccache');
    expect(cache!.with['restore-keys']).toBeUndefined();
    expect(cache!.with.key).toContain('steps.compiler-cache.outputs.toolchain');
    expect(cache!.with.key).toContain('package-lock.json');
    expect(cache!.with.key).toContain('patch-mobile-native-deps.mjs');
    // A release-please version bump changes app.config.ts on every native
    // release; including it silently turns this into a permanently cold cache.
    expect(readFileSync('apps/mobile/app.config.ts', 'utf8')).toContain('x-release-please-version');
    expect(cache!.with.key).not.toContain('apps/mobile/app.config.ts');
    expect(setup!.run).toContain('USE_CCACHE=1');
    expect(setup!.run).toContain(
      'CCACHE_CONFIGPATH=$GITHUB_WORKSPACE/apps/mobile/build/ccache.conf',
    );
    const config = readFileSync('apps/mobile/build/ccache.conf', 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n');
    expect(config).toContain('max_size = 512MiB');
    expect(config).toContain('compiler_check = content');
    expect(config).not.toMatch(/sloppiness\s*=/);
    const stats = steps.find(
      (s: { name?: string }) => s.name === 'Report native compiler cache statistics',
    );
    expect(stats!.if).toContain('always()');
    expect(stats!.run).toContain('ccache --show-stats --verbose');
  });
});
