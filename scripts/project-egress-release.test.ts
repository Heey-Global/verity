import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);
const builder = resolve('scripts/build-project-egress-release.mjs');
const installer = resolve('scripts/project-egress-managed.py');

it('assembles every host asset with verified contents and an executable pinned Node', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verity-egress-release-'));
  try {
    const dockerfile = await readFile('deploy/Dockerfile', 'utf8');
    const stage = dockerfile.split(' AS egress-assets\n')[1]!.split('\nFROM ')[0]!;
    const copiedSources = [...stage.matchAll(/^COPY ([^-]\S*) \S+$/gmu)].map((match) => match[1]!);
    // The installer's fixed manifest is the consumer contract, not a second list
    // of expectations that could drift with the release builder unnoticed.
    const names = JSON.parse(
      (
        await run('python3', [
          '-B',
          '-c',
          'import importlib.util,json,sys;s=importlib.util.spec_from_file_location("installer",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps(m.ASSETS))',
          installer,
        ])
      ).stdout,
    ) as string[];
    const protectedAssets = [
      'devcontainer.js',
      'docker-buildx',
      'protected-build-attempt',
      'protected-build-toolchain.json',
    ];
    for (const name of names.filter((name) => !protectedAssets.includes(name))) {
      const path =
        name === 'node'
          ? join(root, 'node')
          : name === 'native-runtime-pins.env'
            ? join(root, 'deploy/gvisor/versions.env')
            : name.endsWith('.mjs')
              ? join(root, 'packages/server/dist', name)
              : name.endsWith('.o')
                ? join(root, 'objects', name)
                : join(root, 'deploy/egress', name);
      if (path.startsWith(join(root, 'deploy') + '/')) {
        const source = relative(root, path);
        expect(
          copiedSources.some((copy) => source === copy || source.startsWith(copy + '/')),
          `egress-assets must copy release input ${source}`,
        ).toBe(true);
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `fixture:${name}`);
    }
    await writeFile(join(root, 'node'), 'release-pinned-node');
    await run(process.execPath, [builder, 'release', 'objects', join(root, 'node')], { cwd: root });
    const tools = join(root, 'tools');
    await mkdir(tools);
    for (const name of protectedAssets.filter((name) => !name.endsWith('.json')))
      await writeFile(join(tools, name), `fixture:${name}`);
    const feature = 'ghcr.io/heey-global/verity/verity-sandbox-toolkit@sha256:' + 'a'.repeat(64);
    await run(process.execPath, [builder, 'release', '--protected-toolchain', tools], {
      cwd: root,
      env: { ...process.env, VERITY_BUNDLED_PROTECTED_TOOLKIT_FEATURE: feature },
    });
    const policy = JSON.parse(
      await readFile(join(root, 'release/protected-build-toolchain.json'), 'utf8'),
    );
    expect(policy.additionalFeatures).toEqual([feature]);
    expect(policy.nodeOptions).toEqual({ version: '26.13.0' });
    const manifest = JSON.parse(
      await readFile(join(root, 'release/manifest.json'), 'utf8'),
    ) as Record<string, string>;
    expect(Object.keys(manifest).sort()).toEqual(names.sort());
    for (const [name, digest] of Object.entries(manifest)) {
      const bytes = await readFile(join(root, 'release', name));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest);
    }
    expect((await stat(join(root, 'release/node'))).mode & 0o777).toBe(0o555);
    await rm(join(root, 'packages/server/dist/project-egress-host-main.mjs'));
    await symlink(
      join(root, 'node'),
      join(root, 'packages/server/dist/project-egress-host-main.mjs'),
    );
    await expect(
      run(process.execPath, [builder, 'bad-release', 'objects', join(root, 'node')], { cwd: root }),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
