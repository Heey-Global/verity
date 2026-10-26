import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDevcontainerBuildSpawner, devcontainerBuilderEndpoint } from './provisioner.js';
import { DEVCONTAINER_BUILDER_SOCKET_DIRECTORY } from './self-update/deployment-spec.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(fail: 'inspect' | 'build' | undefined = undefined) {
  const root = mkdtempSync(join(tmpdir(), 'verity-builder-test-'));
  roots.push(root);
  const log = join(root, 'calls.jsonl');
  const recorder = `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command: require('node:path').basename(process.argv[1]), args, env: process.env }) + '\\n');
`;
  writeFileSync(
    join(root, 'docker'),
    `#!/usr/bin/env node\n${recorder}\nif (${JSON.stringify(fail)} === 'inspect' && args[1] === 'inspect') process.exit(1);`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(root, 'devcontainer'),
    `#!/usr/bin/env node\n${recorder}\nif (${JSON.stringify(fail)} === 'build') process.exit(1);`,
    { mode: 0o755 },
  );
  vi.stubEnv('PATH', `${root}:${process.env.PATH ?? ''}`);
  vi.stubEnv('VERITY_DEVCONTAINER_BUILDKIT_ENDPOINT', 'unix:///private/buildkit.sock');
  vi.stubEnv('BUILDX_BUILDER', 'ambient-unsafe-builder');
  vi.stubEnv('BUILDKIT_HOST', 'tcp://unsafe:1234');
  return {
    run: () =>
      defaultDevcontainerBuildSpawner({
        workspaceFolder: root,
        imageName: 'probe:test',
        dockerHost: 'unix:///target/docker.sock',
      }),
    calls: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line)) as {
        command: string;
        args: string[];
        env: Record<string, string>;
      }[],
  };
}

describe('secure devcontainer builder selection', () => {
  it.each(['', 'tcp://untrusted:1234', 'unix://relative', 'unix:///bad socket'])(
    'rejects unsupported endpoint %s before spawning',
    async (endpoint) => {
      vi.stubEnv('VERITY_DEVCONTAINER_BUILDKIT_ENDPOINT', endpoint);
      await expect(
        defaultDevcontainerBuildSpawner({
          workspaceFolder: '/unused',
          imageName: 'probe:test',
          dockerHost: 'unix:///unused',
        }),
      ).rejects.toThrow('private runsc worker');
    },
  );

  it('reports builds unavailable without an endpoint or a mounted builder socket', async () => {
    vi.stubEnv('VERITY_DEVCONTAINER_BUILDKIT_ENDPOINT', undefined);
    await expect(
      defaultDevcontainerBuildSpawner({
        workspaceFolder: '/unused',
        imageName: 'probe:test',
        dockerHost: 'unix:///unused',
      }),
    ).rejects.toThrow('Run the Verity installer again');
  });

  // A managed Server sealed with the builder bind has no endpoint variable; the
  // socket is its only configuration. One sealed before it must not be told a
  // builder exists just because the variable is absent.
  it('uses the sealed builder socket only while it exists', () => {
    const socket = `${DEVCONTAINER_BUILDER_SOCKET_DIRECTORY}/buildkitd.sock`;
    expect(devcontainerBuilderEndpoint({}, (path) => path === socket)).toBe(`unix://${socket}`);
    expect(() => devcontainerBuilderEndpoint({}, () => false)).toThrow('builds are unavailable');
    expect(
      devcontainerBuilderEndpoint(
        { VERITY_DEVCONTAINER_BUILDKIT_ENDPOINT: 'unix:///explicit.sock' },
        () => true,
      ),
    ).toBe('unix:///explicit.sock');
    expect(() =>
      devcontainerBuilderEndpoint({ VERITY_DEVCONTAINER_BUILDKIT_ENDPOINT: '' }, () => true),
    ).toThrow('private runsc worker');
  });

  it('selects a private remote builder and removes its config after successful import', async () => {
    const f = fixture();
    await f.run();
    const calls = f.calls();
    expect(calls.map((c) => [c.command, c.args[1]])).toEqual([
      ['docker', 'create'],
      ['docker', 'inspect'],
      ['devcontainer', '--workspace-folder'],
      ['docker', 'rm'],
    ]);
    const create = calls[0]!;
    expect(create.args.slice(-3)).toEqual(['--driver', 'remote', 'unix:///private/buildkit.sock']);
    const build = calls[2]!;
    expect(build.env.BUILDX_BUILDER).toMatch(/^verity-build-/);
    expect(build.env.BUILDX_BUILDER).toBe(create.args[3]);
    expect(build.env.BUILDKIT_HOST).toBeUndefined();
    expect(build.env.DOCKER_HOST).toBe('unix:///target/docker.sock');
    expect(existsSync(build.env.DOCKER_CONFIG!)).toBe(false);
  });

  it.each(['inspect', 'build'] as const)(
    'rejects %s failure, cleans up, and never tries a fallback',
    async (failure) => {
      const f = fixture(failure);
      await expect(f.run()).rejects.toThrow();
      const calls = f.calls();
      expect(calls.at(-1)!.args[1]).toBe('rm');
      expect(calls.filter((c) => c.command === 'devcontainer')).toHaveLength(
        failure === 'inspect' ? 0 : 1,
      );
      expect(calls.filter((c) => c.args[1] === 'create')).toHaveLength(1);
      expect(existsSync(calls[0]!.env.DOCKER_CONFIG!)).toBe(false);
    },
  );
});
