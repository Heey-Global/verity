import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDevcontainerBuildSnapshot,
  trackedBuildInputs,
} from './devcontainer-build-boundary.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(config: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'verity-boundary-test-'));
  roots.push(root);
  mkdirSync(join(root, '.devcontainer'));
  writeFileSync(join(root, '.devcontainer', 'devcontainer.json'), JSON.stringify(config));
  writeFileSync(join(root, '.devcontainer', 'Dockerfile'), 'FROM scratch\nCOPY . /project\n');
  return root;
}
async function snapshot(root: string) {
  const result = await createDevcontainerBuildSnapshot(root);
  roots.push(result.workspaceFolder);
  return result;
}

describe('devcontainer build filesystem boundary', () => {
  it('refuses a symlink in place of the project root', async () => {
    const outside = fixture({ image: 'alpine' });
    const parent = fixture({ image: 'alpine' });
    const linked = join(parent, 'linked-project');
    symlinkSync(outside, linked);
    await expect(snapshot(linked)).rejects.toThrow();
  });

  it('preserves a normal repository context and safe relative symlinks in a private copy', async () => {
    const root = fixture({ build: { dockerfile: 'Dockerfile', context: '..' } });
    writeFileSync(join(root, 'input'), 'authorized');
    symlinkSync('input', join(root, 'link'));
    const copy = await snapshot(root);
    writeFileSync(join(root, 'input'), 'changed after validation');
    expect(readFileSync(join(copy.workspaceFolder, 'link'), 'utf8')).toBe('authorized');
    expect(copy.configFile).toBe(join(copy.workspaceFolder, '.devcontainer/devcontainer.json'));
    await copy.dispose();
    expect(existsSync(copy.workspaceFolder)).toBe(false);
  });

  it.each([
    { build: { context: '../..' } },
    { build: { dockerfile: '../../outside' } },
    { dockerFile: '../../outside' },
    { context: '/' },
    { build: { options: ['--secret=id=server,src=/etc/passwd'] } },
    { dockerComposeFile: 'compose.yml' },
    { build: { cacheFrom: 'type=local,src=/srv/verity' } },
    { cacheFrom: 'type=local,src=/srv/verity' },
    { build: { args: { LEAK: '${localEnv:SECRET}' } } },
    { build: { args: { LEAK: '${env:SECRET}' } } },
    { features: { '../../outside': {} } },
    { features: { '/outside': {} } },
    { features: { 'file:///outside': {} } },
  ])('rejects unconfined or unsupported config %j', async (config) => {
    await expect(snapshot(fixture(config))).rejects.toThrow();
  });

  it.each(['./local-feature', 'ghcr.io/example/features/node:1'])(
    'rejects project Feature %s before the CLI can stage its metadata',
    async (ref) => {
      const root = fixture({ image: 'alpine', features: { [ref]: {} } });
      mkdirSync(join(root, '.devcontainer/local-feature'));
      writeFileSync(
        join(root, '.devcontainer/local-feature/devcontainer-feature.json'),
        '{"id":"benign","version":"1.0.0"}',
      );
      await expect(snapshot(root)).rejects.toThrow('project-declared Features are unsupported');
    },
  );

  it('rejects install-order references that independently resolve Features', async () => {
    const root = fixture({
      image: 'alpine',
      overrideFeatureInstallOrder: ['ghcr.io/example/features/node:1'],
    });
    await expect(snapshot(root)).rejects.toThrow('overrideFeatureInstallOrder is unsupported');
  });

  it('allows empty Feature declarations and ordering', async () => {
    expect(
      (await snapshot(fixture({ image: 'alpine', features: {}, overrideFeatureInstallOrder: [] })))
        .workspaceFolder,
    ).toBeTruthy();
  });

  it('rejects a symlink used to cross the project boundary', async () => {
    const root = fixture({ build: { context: '..' } });
    symlinkSync('/etc', join(root, 'server-files'));
    await expect(snapshot(root)).rejects.toThrow('symbolic link escapes');
  });

  it('rejects an indirect link escape', async () => {
    const root = fixture({ build: { context: '..' } });
    symlinkSync('nested/../../outside', join(root, 'link'));
    await expect(snapshot(root)).rejects.toThrow();
  });

  it('accepts JSONC without interpreting comments or string content as properties', async () => {
    const root = fixture({});
    writeFileSync(
      join(root, '.devcontainer/devcontainer.json'),
      `{
      // build from the repository
      "name": "/* literal */ , }",
      "build": { "dockerfile": "Dockerfile", "context": "..", },
    }`,
    );
    expect((await snapshot(root)).workspaceFolder).not.toBe(root);
  });

  it('decodes escaped security-sensitive keys and values', async () => {
    const root = fixture({});
    writeFileSync(
      join(root, '.devcontainer/devcontainer.json'),
      '{"build":{"opti\\u006fns":["--secret=id=s,src=/etc/passwd"]}}',
    );
    await expect(snapshot(root)).rejects.toThrow('build.options');
  });

  it('pins the supported config even when an alternate root config exists', async () => {
    const root = fixture({ image: 'alpine' });
    writeFileSync(join(root, '.devcontainer.json'), '{"build":{"context":"/"}}');
    const copy = await snapshot(root);
    expect(JSON.parse(readFileSync(copy.configFile, 'utf8'))).toEqual({ image: 'alpine' });
  });

  // Server 4.6.0 snapshotted the whole host clone. Agents' session worktrees and tools
  // put links there that are not part of the project, and one absolute link (a Python
  // venv's interpreter) refused every rebuild: "symbolic link escapes the project".
  describe('inputs limited to what the repository tracks', () => {
    const git = (root: string, ...args: string[]) =>
      execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        stdio: 'pipe',
      });
    function repository(initArgs: string[] = []): string {
      const root = fixture({ build: { dockerfile: 'Dockerfile', context: '..' } });
      writeFileSync(join(root, 'app.js'), 'console.log(1)\n');
      mkdirSync(join(root, 'lib'));
      writeFileSync(join(root, 'lib', 'util.js'), 'export {}\n');
      symlinkSync('lib/util.js', join(root, 'util-link.js'));
      git(root, 'init', '-q', ...initArgs);
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'init');
      return root;
    }
    function agentLeftovers(root: string): void {
      mkdirSync(join(root, '.venv', 'bin'), { recursive: true });
      symlinkSync('/usr/bin/python3', join(root, '.venv', 'bin', 'python'));
      mkdirSync(join(root, '.verity-sessions', 's1', 'node_modules'), { recursive: true });
      symlinkSync('/etc', join(root, '.verity-sessions', 's1', 'node_modules', 'etc'));
      writeFileSync(join(root, 'scratch.log'), 'untracked\n');
    }

    it('builds from tracked files and ignores links agents left untracked', async () => {
      const root = repository();
      agentLeftovers(root);
      const result = await snapshot(root);
      const at = (path: string) => existsSync(join(result.workspaceFolder, path));
      expect(at('app.js') && at('lib/util.js') && at('util-link.js')).toBe(true);
      expect(at('.devcontainer/devcontainer.json')).toBe(true);
      for (const absent of ['.venv', '.verity-sessions', 'scratch.log', '.git']) {
        expect(at(absent)).toBe(false);
      }
    });

    it('still refuses a committed link out of the project, and names it', async () => {
      const root = repository();
      symlinkSync('/etc/passwd', join(root, 'leak'));
      git(root, 'add', 'leak');
      await expect(snapshot(root)).rejects.toThrow(
        'symbolic link escapes the project: leak -> /etc/passwd',
      );
    });

    it('reads the configuration even when it was never committed', async () => {
      const root = fixture({ image: 'alpine' });
      writeFileSync(join(root, 'app.js'), '1\n');
      git(root, 'init', '-q');
      git(root, 'add', 'app.js');
      const result = await snapshot(root);
      expect(existsSync(join(result.workspaceFolder, '.devcontainer', 'devcontainer.json'))).toBe(
        true,
      );
    });

    it('reads a version 4 index', () => {
      const root = repository();
      git(root, 'update-index', '--index-version', '4');
      expect(trackedBuildInputs(root)?.files).toEqual(
        new Set([
          '.devcontainer/Dockerfile',
          '.devcontainer/devcontainer.json',
          'app.js',
          'lib/util.js',
          'util-link.js',
        ]),
      );
    });

    it('reads a SHA-256 repository index', () => {
      let root: string;
      try {
        root = repository(['--object-format=sha256']);
      } catch {
        return; // This git predates SHA-256 repositories.
      }
      expect(trackedBuildInputs(root)?.files.has('lib/util.js')).toBe(true);
    });

    it('falls back to the whole clone, minus session worktrees, without a readable index', async () => {
      const root = fixture({ image: 'alpine' });
      mkdirSync(join(root, '.verity-sessions', 's1'), { recursive: true });
      symlinkSync('/etc', join(root, '.verity-sessions', 's1', 'etc'));
      writeFileSync(join(root, 'app.js'), '1\n');
      expect(trackedBuildInputs(root)).toBeNull();
      const result = await snapshot(root);
      expect(existsSync(join(result.workspaceFolder, 'app.js'))).toBe(true);
      expect(existsSync(join(result.workspaceFolder, '.verity-sessions'))).toBe(false);
    });
  });
});
