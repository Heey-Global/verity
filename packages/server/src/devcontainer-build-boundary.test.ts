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
  DEVCONTAINER_BASE_IMAGE_ARG,
  pinDevcontainerBaseImage,
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

    it('reads a version 4 index whose paths are not ASCII', () => {
      const root = repository();
      writeFileSync(join(root, 'aé.txt'), '1\n');
      writeFileSync(join(root, 'b.txt'), '1\n');
      git(root, 'add', 'aé.txt', 'b.txt');
      git(root, 'update-index', '--index-version', '4');
      const files = trackedBuildInputs(root)?.files;
      expect(files?.has('aé.txt') && files.has('b.txt') && files.has('lib/util.js')).toBe(true);
    });

    // The Sandbox can rewrite .git at any time. A FIFO in place of the index would block
    // the server's event loop on a plain read; a link must not be followed either.
    it('never blocks on, or follows, Git metadata the Sandbox swapped', () => {
      const root = repository();
      const index = join(root, '.git', 'index');
      rmSync(index);
      execFileSync('mkfifo', [index]);
      const started = Date.now();
      expect(trackedBuildInputs(root)).toBeNull();
      expect(Date.now() - started).toBeLessThan(2_000);

      const other = repository();
      rmSync(index);
      symlinkSync(join(other, '.git', 'index'), index);
      expect(trackedBuildInputs(root)).toBeNull();

      const config = join(other, '.git', 'config');
      rmSync(config);
      execFileSync('mkfifo', [config]);
      expect(trackedBuildInputs(other)?.files.has('app.js')).toBe(true);
    });

    it("takes a submodule's tracked files, not what was left in its worktree", async () => {
      const library = repository();
      const root = repository();
      git(
        root,
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        library,
        'vendor/lib',
      );
      git(root, 'commit', '-q', '-m', 'submodule');
      mkdirSync(join(root, 'vendor', 'lib', '.venv'));
      symlinkSync('/usr/bin/python3', join(root, 'vendor', 'lib', '.venv', 'python'));
      const result = await snapshot(root);
      expect(existsSync(join(result.workspaceFolder, 'vendor', 'lib', 'lib', 'util.js'))).toBe(
        true,
      );
      expect(existsSync(join(result.workspaceFolder, 'vendor', 'lib', '.venv'))).toBe(false);
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

describe('pinDevcontainerBaseImage', () => {
  const pinned = `ghcr.io/heey-global/verity/verity-sandbox:v4.16.0@sha256:${'a'.repeat(64)}`;
  const buildArgs = (configFile: string): Record<string, string> | undefined =>
    (JSON.parse(readFileSync(configFile, 'utf8')) as { build?: { args?: Record<string, string> } })
      .build?.args;

  it('hands a Dockerfile that declares the argument the pinned base, keeping its other args', async () => {
    // Without it the Dockerfile's own default (`:latest`) wins, the sandbox lags
    // the Server's release, and the reconciler recreates it every minute.
    const root = fixture({ build: { dockerfile: 'Dockerfile', args: { OTHER: 'kept' } } });
    writeFileSync(
      join(root, '.devcontainer', 'Dockerfile'),
      // Instruction keywords are case-insensitive in a Dockerfile.
      `arg ${DEVCONTAINER_BASE_IMAGE_ARG}=example/base:latest\nFROM \${${DEVCONTAINER_BASE_IMAGE_ARG}}\n`,
    );
    const copy = await snapshot(root);
    pinDevcontainerBaseImage(copy, pinned);
    expect(buildArgs(copy.configFile)).toEqual({
      OTHER: 'kept',
      [DEVCONTAINER_BASE_IMAGE_ARG]: pinned,
    });
    // Only the private copy is rewritten; the clone keeps what its hash covers.
    expect(buildArgs(join(root, '.devcontainer', 'devcontainer.json'))).toEqual({ OTHER: 'kept' });
  });

  it('leaves a Dockerfile that does not declare the argument alone', async () => {
    const root = fixture({ build: { dockerfile: 'Dockerfile' } });
    const copy = await snapshot(root);
    const before = readFileSync(copy.configFile, 'utf8');
    pinDevcontainerBaseImage(copy, pinned);
    expect(readFileSync(copy.configFile, 'utf8')).toBe(before);
  });

  it('leaves an image-only configuration alone', async () => {
    const root = fixture({ image: 'alpine' });
    const copy = await snapshot(root);
    const before = readFileSync(copy.configFile, 'utf8');
    pinDevcontainerBaseImage(copy, pinned);
    expect(readFileSync(copy.configFile, 'utf8')).toBe(before);
  });

  it("pins this repository's own devcontainer", async () => {
    // The repo Dockerfile is the one that looped: a Server on a staging release
    // pinned v4.16.0 while `:latest` was still v4.15.0. Run against the real
    // files, so renaming the ARG or dropping it fails here rather than in the
    // fleet.
    const repoDevcontainer = join(import.meta.dirname, '..', '..', '..', '.devcontainer');
    const root = mkdtempSync(join(tmpdir(), 'verity-boundary-repo-'));
    roots.push(root);
    mkdirSync(join(root, '.devcontainer'));
    for (const name of ['devcontainer.json', 'Dockerfile']) {
      writeFileSync(
        join(root, '.devcontainer', name),
        readFileSync(join(repoDevcontainer, name), 'utf8'),
      );
    }
    const copy = await snapshot(root);
    pinDevcontainerBaseImage(copy, pinned);
    expect(buildArgs(copy.configFile)?.[DEVCONTAINER_BASE_IMAGE_ARG]).toBe(pinned);
    expect(readFileSync(join(repoDevcontainer, 'Dockerfile'), 'utf8')).toMatch(
      new RegExp(`^FROM \\$\\{${DEVCONTAINER_BASE_IMAGE_ARG}\\}$`, 'mu'),
    );
  });
});
