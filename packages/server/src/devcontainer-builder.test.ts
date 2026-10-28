import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDevcontainerBuildSpawner, devcontainerBuilderEndpoint } from './provisioner.js';
import { BuildStorage, type BuildStorageLease } from './build-storage.js';
import { DEVCONTAINER_BUILDER_SOCKET_DIRECTORY } from './self-update/deployment-spec.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(fail: 'inspect' | 'build' | 'load' | undefined = undefined) {
  const root = mkdtempSync(join(tmpdir(), 'verity-builder-test-'));
  roots.push(root);
  const log = join(root, 'calls.jsonl');
  const recorder = `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command: require('node:path').basename(process.argv[1]), args, env: process.env }) + '\\n');
`;
  writeFileSync(
    join(root, 'docker'),
    `#!/usr/bin/env node\n${recorder}\nif (${JSON.stringify(fail)} === 'inspect' && args[1] === 'inspect') process.exit(1);
if (${JSON.stringify(fail)} === 'load' && args[0] === 'load') process.exit(1);`,
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
    root,
    run: (storageLease?: BuildStorageLease, signal?: AbortSignal) =>
      defaultDevcontainerBuildSpawner({
        workspaceFolder: root,
        imageName: 'probe:test',
        dockerHost: 'unix:///target/docker.sock',
        ...(storageLease === undefined ? {} : { storageLease }),
        ...(signal === undefined ? {} : { signal }),
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
      ['docker', '--input'],
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
    // The image reaches the Engine from the archive the build wrote, not through --load.
    const archive = build.args[build.args.indexOf('--output') + 1]!.replace(
      'type=docker,dest=',
      '',
    );
    expect(archive.startsWith(`${build.env.DOCKER_CONFIG}/`)).toBe(true);
    expect(calls[3]!.args).toEqual(['load', '--input', archive]);
    expect(calls[3]!.env.DOCKER_HOST).toBe('unix:///target/docker.sock');
  });

  it.each(['inspect', 'build', 'load'] as const)(
    'rejects %s failure, cleans up, and never tries a fallback',
    async (failure) => {
      const f = fixture(failure);
      await expect(f.run()).rejects.toThrow();
      const calls = f.calls();
      expect(calls.at(-1)!.args[1]).toBe('rm');
      expect(calls.filter((c) => c.command === 'devcontainer')).toHaveLength(
        failure === 'inspect' ? 0 : 1,
      );
      expect(calls.filter((c) => c.args[0] === 'load')).toHaveLength(failure === 'load' ? 1 : 0);
      expect(calls.filter((c) => c.args[1] === 'create')).toHaveLength(1);
      expect(existsSync(calls[0]!.env.DOCKER_CONFIG!)).toBe(false);
    },
  );
});

describe('production spawner remote reservation lifecycle', () => {
  it.each(['build', 'load', undefined] as const)(
    'preserves uncertain remote artifacts on %s and releases confirmed success',
    async (failure) => {
      const f = fixture(failure);
      const root = join(f.root, 'build-storage');
      const report = join(f.root, 'report.json');
      writeFileSync(
        report,
        JSON.stringify({
          schemaVersion: 1,
          hostBootId: '11111111-1111-4111-8111-111111111111',
          hostIdentity: 'a'.repeat(64),
          observedAt: new Date().toISOString(),
          roots: ['buildkit', 'docker', 'containerd', 'export', 'project'].map((kind) => ({
            kind,
            state: 'available',
            observedAt: new Date().toISOString(),
            filesystemId: 'test',
            availableBytes: 1e12,
            freeInodes: 1e9,
          })),
        }),
      );
      const manager = () =>
        new BuildStorage(
          root,
          report,
          { estimateBytes: 1, reserveBytes: 1, reserveInodes: 1 },
          () => ({ availableBytes: 1e12, freeInodes: 1e9 }),
        );
      const storage = manager();
      const lease = storage.acquire();
      lease.reserveBuild();
      if (failure === undefined) await f.run(lease);
      else await expect(f.run(lease)).rejects.toThrow('failed');
      const calls = f.calls();
      const config = calls[0]!.env.DOCKER_CONFIG!;
      expect(lease.retainArtifacts).toBe(failure !== undefined);
      lease.dispose();
      if (failure === undefined) {
        expect(existsSync(config)).toBe(false);
        storage.acquire().dispose();
        manager().acquire().dispose();
      } else {
        expect(existsSync(config)).toBe(true);
        expect(
          JSON.parse(readFileSync(join(lease.directory, 'remote-operation.json'), 'utf8')),
        ).toMatchObject({ operation: failure === 'build' ? 'build-export' : 'image-import' });
        // Recovery must not trust local process death, namespace replacement or age.
        writeFileSync(
          join(lease.directory, 'owner.json'),
          JSON.stringify({
            version: 1,
            pid: 2147483647,
            start: '0',
            namespace: 'previous-server',
          }),
        );
        // The unconfirmed attempt keeps its record and reserves its estimate, but no
        // longer refuses every later build on the host.
        for (const next of [storage, manager()]) {
          next.acquire().dispose();
          expect(next.unresolvedAttempts()).toEqual([
            expect.objectContaining({ attempt: basename(lease.directory) }),
          ]);
        }
        expect(existsSync(join(lease.directory, 'remote-operation.json'))).toBe(true);
        expect(existsSync(config)).toBe(true);
      }
    },
  );
});

it.each([
  ['build', 'timeout'],
  ['build', 'abort'],
  ['load', 'timeout'],
  ['load', 'abort'],
] as const)(
  'production %s %s retains admission after client termination',
  async (phase, reason) => {
    const f = fixture();
    const ready = join(f.root, 'remote-started');
    const script = `#!/usr/bin/env node
const fs = require('node:fs');
if (${JSON.stringify(phase)} === 'build' || process.argv[2] === 'load') {
  fs.writeFileSync(${JSON.stringify(ready)}, 'started');
  setInterval(() => {}, 1000);
}
`;
    writeFileSync(join(f.root, phase === 'build' ? 'devcontainer' : 'docker'), script, {
      mode: 0o755,
    });
    const report = join(f.root, 'report.json');
    writeFileSync(
      report,
      JSON.stringify({
        schemaVersion: 1,
        observedAt: new Date().toISOString(),
        hostBootId: '11111111-1111-4111-8111-111111111111',
        hostIdentity: 'a'.repeat(64),
        roots: [],
      }),
    );
    const storage = new BuildStorage(
      join(f.root, 'build-storage'),
      report,
      { estimateBytes: 1, reserveBytes: 1, reserveInodes: 1 },
      () => ({ availableBytes: 1e12, freeInodes: 1e9 }),
    );
    const lease = storage.acquire();
    const run = lease.run;
    lease.run = (command, args, options) =>
      run(command, args, {
        ...options,
        timeout: reason === 'timeout' && options.remoteOperation ? 150 : options.timeout,
      });
    const controller = new AbortController();
    const pending = f.run(lease, controller.signal);
    const rejected = expect(pending).rejects.toThrow(reason === 'abort' ? 'aborted' : 'timed out');
    if (reason === 'abort') {
      await expect.poll(() => existsSync(ready), { timeout: 3000 }).toBe(true);
      controller.abort();
    }
    await rejected;
    expect(lease.retainArtifacts).toBe(true);
    lease.dispose();
    // Kept as an unresolved reservation for reconciliation, not a host-wide block.
    storage.acquire().dispose();
    expect(existsSync(join(lease.directory, 'remote-operation.json'))).toBe(true);
    expect(storage.unresolvedAttempts()).toEqual([
      expect.objectContaining({ attempt: basename(lease.directory) }),
    ]);
  },
);
