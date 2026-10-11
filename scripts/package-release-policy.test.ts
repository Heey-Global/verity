import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RELEASE_DELAY_POLICIES,
  classifyInstall,
  configureReleaseDelay,
  detectReleaseDelay,
  effectiveInstallDirectory,
  supportsReleaseDelay,
} from '../features/verity-sandbox-toolkit/bin/verity-package-policy.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function project() {
  const root = mkdtempSync(join(tmpdir(), 'verity-package-policy-'));
  roots.push(root);
  mkdirSync(join(root, '.git'));
  return root;
}

describe('install classification', () => {
  it.each([
    ['npm', ['i', 'express']],
    ['npm', ['--prefix', '/tmp/project', 'install']],
    ['npm', ['audit', 'fix']],
    ['npm', ['exec', '--', 'example']],
    ['npm', ['ci']],
    ['pnpm', ['-C', '/tmp/project', 'add', 'express']],
    ['pnpm', ['dlx', 'example']],
    ['pnpm', ['-w', 'add', 'example']],
    ['pnpm', ['--workspace', 'add', 'example']],
    ['npm', ['-w', 'web', 'install']],
    ['yarn', []],
    ['yarn', ['--cwd=/tmp/project', 'install']],
    ['yarn', ['upgrade-interactive']],
    ['bun', ['add', 'express']],
    ['bun', ['-c', 'custom.toml', 'install']],
    ['bun', ['x', 'example']],
    ['pip', ['install', '--upgrade', 'requests']],
    ['pip', ['--require-virtualenv', 'install', 'requests']],
    ['pip', ['--keyring-provider', 'disabled', 'install', 'requests']],
    ['npm', ['--registry', 'https://registry.example.test', 'install', 'express']],
    ['pnpm', ['--filter', 'web', 'install']],
    ['uv', ['pip', 'install', 'pandas']],
    ['uv', ['tool', 'run', 'ruff']],
    ['uv', ['sync']],
    ['uv', ['run', 'script.py']],
    ['yarn', ['add', 'example', '--version', '2.0.0']],
  ] as [string, string[]][])('recognizes %s %j', (manager, args) => {
    expect(classifyInstall(manager, args)).toBe(true);
  });
  it.each([
    ['npm', ['run', 'build']],
    ['npm', ['--version']],
    ['npm', ['install', '--help']],
    ['npm', ['audit']],
    ['pnpm', ['list']],
    ['yarn', ['run', 'build']],
    ['bun', ['test']],
    ['pip', ['list']],
    ['pip', ['download', 'requests']],
    ['uv', ['venv']],
    ['uv', ['pip', 'list']],
  ] as [string, string[]][])('passes through %s %j', (manager, args) => {
    expect(classifyInstall(manager, args)).toBe(false);
  });
  it.each([
    ['npm', ['--prefix', 'app']],
    ['pnpm', ['-C', 'app']],
    ['yarn', ['--cwd=app']],
    ['uv', ['--directory', 'app']],
    ['bun', ['--cwd=app']],
  ] as [string, string[]][])('uses the actual target directory for %s', (manager, args) => {
    expect(effectiveInstallDirectory(manager, args, '/work')).toBe('/work/app');
  });
});

describe('release delay configuration', () => {
  it('does not mistake invalid unit strings for an effective native setting', () => {
    const root = project();
    writeFileSync(join(root, '.npmrc'), 'min-release-age=3d\n');
    expect(detectReleaseDelay('npm', root).protected).toBe(false);
    writeFileSync(join(root, 'pip.conf'), '[install]\nuploaded-prior-to=PT72H\n');
    expect(detectReleaseDelay('pip', root).protected).toBe(false);
    writeFileSync(join(root, '.yarnrc.yml'), 'npmMinimalAgeGate: "3d"\n');
    expect(detectReleaseDelay('yarn', root, {}, '4.10.0').protected).toBe(false);
    expect(detectReleaseDelay('yarn', root, {}, '4.11.0').protected).toBe(true);
  });
  it('preserves an absolute cutoff that already excludes the last three days', () => {
    const root = project();
    const path = join(root, 'uv.toml');
    const text = `exclude-newer = "${new Date(Date.now() - 4 * 86400_000).toISOString()}"\n`;
    writeFileSync(path, text);
    expect(detectReleaseDelay('uv', root).protected).toBe(true);
    configureReleaseDelay('uv', root, '0.9.17');
    expect(readFileSync(path, 'utf8')).toBe(text);
  });
  it.each(Object.keys(RELEASE_DELAY_POLICIES))(
    'sets %s without losing existing project configuration',
    (manager) => {
      const root = project();
      const policy = RELEASE_DELAY_POLICIES[manager];
      const path = join(root, policy.file);
      const existing =
        manager === 'npm'
          ? 'registry=https://registry.example.test/\n'
          : manager === 'pnpm'
            ? 'packages:\n  - packages/*\n'
            : manager === 'yarn'
              ? 'nodeLinker: node-modules\n'
              : manager === 'pip'
                ? '[global]\nindex-url = https://index.example.test/simple\n'
                : '[unrelated]\nvalue = "preserve"\n';
      writeFileSync(path, existing);
      expect(detectReleaseDelay(manager, root).protected).toBe(false);
      const detected = configureReleaseDelay(manager, root, policy.minimumVersion);
      expect(detected.protected).toBe(true);
      expect(readFileSync(path, 'utf8')).toContain(existing.trim());
      const configured = readFileSync(path, 'utf8');
      configureReleaseDelay(manager, root, policy.minimumVersion);
      expect(readFileSync(path, 'utf8')).toBe(configured);
      // Removing the actual configured key must lose protection, whatever the
      // manager's file, section, unit or spelling is.
      writeFileSync(
        path,
        configured
          .split('\n')
          .filter((line) => !line.includes(detected.key))
          .join('\n'),
      );
      expect(detectReleaseDelay(manager, root).protected).toBe(false);
    },
  );

  it('strengthens an existing npm value and preserves its inline comment and CRLF', () => {
    const root = project();
    writeFileSync(
      join(root, '.npmrc'),
      'min-release-age=1 # project policy\r\nregistry=https://registry.example.test/\r\n',
    );
    configureReleaseDelay('npm', root, '11.19.0');
    const text = readFileSync(join(root, '.npmrc'), 'utf8');
    expect(text).toContain('3 # project policy\r\n');
    expect((text.match(/min-release-age/gu) ?? []).length).toBe(1);
  });

  it('preserves a stricter existing delay and detects quoted or indented TOML keys', () => {
    const root = project();
    const path = join(root, 'bunfig.toml');
    const text = '[install]\n  "minimumReleaseAge" = 604800\n';
    writeFileSync(path, text);
    expect(detectReleaseDelay('bun', root).protected).toBe(true);
    configureReleaseDelay('bun', root, '1.3.0');
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it('merges uv into an existing pyproject tool table rather than writing a competing config', () => {
    const root = project();
    const path = join(root, 'pyproject.toml');
    writeFileSync(path, '[project]\nname = "example"\n[tool.uv]\nindex-strategy = "first-index"\n');
    expect(configureReleaseDelay('uv', root, '0.9.17').path).toBe(path);
    expect(readFileSync(path, 'utf8')).toContain('index-strategy = "first-index"');
    expect(detectReleaseDelay('uv', root).protected).toBe(true);
  });

  it.each([
    '[tool]\nuv = { index-strategy = "first-index" }\n',
    'tool.uv.index-strategy = "first-index"\n',
    'tool = { uv = { index-strategy = "first-index" } }\n',
  ])('rejects TOML forms the merger cannot preserve without modifying them: %s', (text) => {
    const root = project();
    const path = join(root, 'pyproject.toml');
    writeFileSync(path, text);
    expect(() => configureReleaseDelay('uv', root, '0.9.17')).toThrow('Unsupported');
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(detectReleaseDelay('uv', root).protected).toBe(false);
  });

  it('rejects multiline TOML examples before detecting or modifying fake settings', () => {
    const root = project();
    const path = join(root, 'pyproject.toml');
    const text = '[project]\ndescription = """\n[tool.uv]\nexclude-newer = "P3D"\n"""\n';
    writeFileSync(path, text);
    expect(() => configureReleaseDelay('uv', root, '0.9.17')).toThrow('Unsupported');
    expect(detectReleaseDelay('uv', root)).toMatchObject({
      protected: false,
      setupSupported: false,
    });
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it('respects a Bun project override over the user configuration', () => {
    const root = project();
    const home = project();
    writeFileSync(join(home, '.bunfig.toml'), '[install]\nminimumReleaseAge = 604800\n');
    writeFileSync(join(root, 'bunfig.toml'), '[install]\nminimumReleaseAge = 0\n');
    expect(detectReleaseDelay('bun', root, { HOME: home }).protected).toBe(false);
    configureReleaseDelay('bun', root, '1.3.0', { HOME: home });
    expect(detectReleaseDelay('bun', root, { HOME: home }).protected).toBe(true);
  });

  it.each(['bun', 'uv'])('retains %s user configuration', (manager) => {
    const root = project();
    const home = project();
    const path =
      manager === 'bun' ? join(home, '.bunfig.toml') : join(home, '.config', 'uv', 'uv.toml');
    mkdirSync(join(home, '.config', 'uv'), { recursive: true });
    writeFileSync(
      path,
      manager === 'bun' ? '[install]\nminimumReleaseAge = 604800\n' : 'exclude-newer = "P7D"\n',
    );
    expect(detectReleaseDelay(manager, root, { HOME: home }).protected).toBe(true);
    configureReleaseDelay(manager, root, manager === 'bun' ? '1.3.0' : '0.9.17', { HOME: home });
    expect(readFileSync(path, 'utf8')).toContain(manager === 'bun' ? '604800' : 'P7D');
  });

  it('uses the native Yarn effective value when its environment overrides the project', () => {
    const root = project();
    writeFileSync(join(root, '.yarnrc.yml'), 'npmMinimalAgeGate: 4320\n');
    const env = { VERITY_NATIVE_RELEASE_AGE: '0' };
    expect(detectReleaseDelay('yarn', root, env, '4.10.0').protected).toBe(false);
    expect(configureReleaseDelay('yarn', root, '4.10.0', env).protected).toBe(true);
  });

  it.each(['["install"]\nminimumReleaseAge = 0\n', '[tool."uv"]\nexclude-newer = "P0D"\n'])(
    'rejects quoted TOML table forms before writing: %s',
    (text) => {
      const root = project();
      const manager = text.startsWith('[tool') ? 'uv' : 'bun';
      const path = join(root, manager === 'uv' ? 'pyproject.toml' : 'bunfig.toml');
      writeFileSync(path, text);
      expect(detectReleaseDelay(manager, root).setupSupported).toBe(false);
      expect(() =>
        configureReleaseDelay(manager, root, manager === 'uv' ? '0.9.17' : '1.3.0'),
      ).toThrow('Unsupported');
      expect(readFileSync(path, 'utf8')).toBe(text);
    },
  );

  it.each([
    '{packages: ["packages/*"]}\n',
    '"minimumReleaseAge": 0\n',
    'minimumReleaseAge: &age 1440\nother: *age\n',
  ])('leaves unsupported YAML forms intact: %s', (text) => {
    const root = project();
    const path = join(root, 'pnpm-workspace.yaml');
    writeFileSync(path, text);
    expect(detectReleaseDelay('pnpm', root).setupSupported).toBe(false);
    expect(() => configureReleaseDelay('pnpm', root, '11.0.0')).toThrow('Unsupported');
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it('resolves uv project paths after its working-directory option', () => {
    expect(effectiveInstallDirectory('uv', ['-C', 'app', 'sync'], '/work')).toBe('/work/app');
    for (const args of [
      ['--directory', 'app', '--project', 'backend', 'sync'],
      ['--project', 'backend', '--directory', 'app', 'sync'],
    ]) {
      expect(effectiveInstallDirectory('uv', args, '/work')).toBe('/work/app/backend');
    }
  });

  it('does not inherit Bun configuration from an ancestor directory', () => {
    const root = project();
    const child = join(root, 'child');
    mkdirSync(child);
    const ancestor = join(root, 'bunfig.toml');
    writeFileSync(ancestor, '[install]\nminimumReleaseAge = 604800\n');
    expect(detectReleaseDelay('bun', child, { HOME: join(root, 'empty-home') }).protected).toBe(
      false,
    );
    configureReleaseDelay('bun', child, '1.3.0', { HOME: join(root, 'empty-home') });
    expect(readFileSync(ancestor, 'utf8')).toContain('604800');
    expect(detectReleaseDelay('bun', child).protected).toBe(true);
    expect(readFileSync(join(child, 'bunfig.toml'), 'utf8')).toContain('259200');
  });

  it.each(['pnpm', 'yarn'])('preserves an indented %s YAML root mapping', (manager) => {
    const root = project();
    const path = join(root, manager === 'pnpm' ? 'pnpm-workspace.yaml' : '.yarnrc.yml');
    const text =
      manager === 'pnpm'
        ? '# Workspace\n  packages: ["packages/*"]\n  minimumReleaseAge: 10080\n'
        : '# Yarn\n  nodeLinker: node-modules\n  npmMinimalAgeGate: 10080\n';
    writeFileSync(path, text);
    expect(detectReleaseDelay(manager, root).setupSupported).toBe(false);
    expect(() =>
      configureReleaseDelay(manager, root, manager === 'pnpm' ? '11.0.0' : '4.10.0'),
    ).toThrow('Unsupported');
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it('leaves indented pip configuration untouched rather than corrupting continuations', () => {
    const root = project();
    const path = join(root, 'pip.conf');
    const text = '[install]\n  uploaded-prior-to=P1D\n  index-url=https://index.example/simple\n';
    writeFileSync(path, text);
    expect(detectReleaseDelay('pip', root)).toMatchObject({
      protected: false,
      setupSupported: false,
    });
    expect(() => configureReleaseDelay('pip', root, '26.2.1')).toThrow(/Unsupported configuration/);
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it('retains a stronger Bun delay with an adjacent TOML comment', () => {
    const root = project();
    const path = join(root, 'bunfig.toml');
    const text = '[install]\nminimumReleaseAge = 604800# policy\n';
    writeFileSync(path, text);
    expect(detectReleaseDelay('bun', root).protected).toBe(true);
    configureReleaseDelay('bun', root, '1.3.0');
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it('merges pip options regardless of key casing', () => {
    const root = project();
    const path = join(root, 'pip.conf');
    writeFileSync(path, '[install]\nUPLOADED-PRIOR-TO=P1D\ntimeout=30\n');
    expect(detectReleaseDelay('pip', root).protected).toBe(false);
    configureReleaseDelay('pip', root, '26.2.1');
    const text = readFileSync(path, 'utf8');
    expect(text.match(/uploaded-prior-to/gi)).toHaveLength(1);
    expect(text).toContain('timeout=30');
    expect(detectReleaseDelay('pip', root).protected).toBe(true);
    writeFileSync(path, '[install]\nUPLOADED-PRIOR-TO=P7D\n');
    expect(detectReleaseDelay('pip', root).protected).toBe(true);
  });

  it('uses pip custom configuration and recognizes its global setting', () => {
    const root = project();
    const path = join(root, 'custom-pip.conf');
    const env = { PIP_CONFIG_FILE: path };
    writeFileSync(path, '[global]\nuploaded-prior-to=P4D\n[install]\ntimeout=30\n');
    expect(detectReleaseDelay('pip', root, env)).toMatchObject({ protected: true, path });
    writeFileSync(path, '[global]\nindex-url=https://index.example.test/simple\n');
    configureReleaseDelay('pip', root, 'pip 26.1 from /test (python 3.14)', env);
    expect(readFileSync(path, 'utf8')).toContain('index-url=https://index.example.test/simple');
    expect(detectReleaseDelay('pip', root, env).protected).toBe(true);
  });

  it('finds pnpm legacy npmrc protection and avoids a second setting', () => {
    const root = project();
    const path = join(root, '.npmrc');
    writeFileSync(path, 'minimum-release-age=4320\n');
    const workspace = join(root, 'pnpm-workspace.yaml');
    writeFileSync(workspace, 'packages:\n  - packages/*\n');
    expect(detectReleaseDelay('pnpm', root)).toMatchObject({ protected: true, path });
    configureReleaseDelay('pnpm', root, '10.16.0');
    expect(readFileSync(path, 'utf8')).toBe('minimum-release-age=4320\n');
    expect(readFileSync(workspace, 'utf8')).not.toContain('minimumReleaseAge');
    expect(detectReleaseDelay('pnpm', root, {}, '11.0.0').protected).toBe(false);
  });

  it.each([
    ['npm', { npm_config_min_release_age: '7' }, '7'],
    ['npm', { NPM_CONFIG_MIN_RELEASE_AGE: '7' }, '7'],
    ['uv', { UV_EXCLUDE_NEWER: 'P7D' }, 'P7D'],
  ] as [string, Record<string, string>, string][])(
    'preserves stricter %s environment protection',
    (manager, env, expected) => {
      const root = project();
      const policy = RELEASE_DELAY_POLICIES[manager];
      configureReleaseDelay(manager, root, policy.minimumVersion);
      expect(detectReleaseDelay(manager, root, env)).toMatchObject({
        protected: true,
        value: expected,
      });
      expect(configureReleaseDelay(manager, root, policy.minimumVersion, env).value).toBe(expected);
    },
  );

  it('ignores nested YAML settings and refuses duplicate keys without rewriting the file', () => {
    const root = project();
    const path = join(root, '.yarnrc.yml');
    writeFileSync(path, 'npmScopes:\n  example:\n    npmMinimalAgeGate: 4320\n');
    expect(detectReleaseDelay('yarn', root).protected).toBe(false);
    const duplicated = 'npmMinimalAgeGate: 4320\nnpmMinimalAgeGate: 0\n';
    writeFileSync(path, duplicated);
    expect(detectReleaseDelay('yarn', root).protected).toBe(false);
    expect(() => configureReleaseDelay('yarn', root, '4.10.0')).toThrow('Duplicate');
    expect(readFileSync(path, 'utf8')).toBe(duplicated);
  });

  it.each(Object.entries(RELEASE_DELAY_POLICIES))(
    'gates %s by the installed version',
    (manager, policy) => {
      expect(supportsReleaseDelay(manager, policy.minimumVersion)).toBe(true);
      const parts = policy.minimumVersion.split('.').map(Number);
      const previous =
        parts[2] > 0 ? `${parts[0]}.${parts[1]}.${parts[2] - 1}` : `${parts[0]}.${parts[1] - 1}.99`;
      expect(supportsReleaseDelay(manager, previous)).toBe(false);
      expect(supportsReleaseDelay(manager, `${policy.minimumVersion}-rc.1`)).toBe(false);
      const root = project();
      expect(() => configureReleaseDelay(manager, root, previous)).toThrow('does not support');
    },
  );
});
