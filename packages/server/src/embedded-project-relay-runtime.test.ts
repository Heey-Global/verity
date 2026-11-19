import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventStore } from '@verity/store';
import type { ProjectRelayRuntimeOptions } from './project-relay-runtime.js';
import { createProjectRelayRuntime } from './project-relay-runtime.js';
import { installEmbeddedProjectRelayRuntime } from './embedded-project-relay-runtime.js';
import { mkdirSync } from 'node:fs';

vi.mock('node:fs', () => ({ mkdirSync: vi.fn() }));
vi.mock('./project-relay-runtime.js', () => ({ createProjectRelayRuntime: vi.fn() }));

type Context = Parameters<typeof installEmbeddedProjectRelayRuntime>[0];
function fixture() {
  const getProject = vi.fn<EventStore['getProject']>();
  const getConnection = vi.fn<EventStore['forgeConnections']['get']>();
  const eventStore = {
    getProject,
    forgeConnections: { get: getConnection },
    projectSandboxes: { projectDefault: vi.fn() },
  } as unknown as Context['eventStore'];
  const context = {
    app: {},
    config: {
      dataVolumeRoot: '/data',
      dataVolume: 'data',
      projectRelayImage: 'relay',
      projectRelayGid: process.getgid?.() ?? 65532,
    },
    projectRelayEnabled: true,
    docker: {},
    signingCapabilities: {},
    ghTokenCapabilities: {},
    eventStore,
    sandboxNetworkName: vi.fn(),
  } as unknown as Context;
  return { context, getProject, getConnection };
}
function options(): ProjectRelayRuntimeOptions {
  return vi.mocked(createProjectRelayRuntime).mock.calls.at(-1)![0];
}
afterEach(() => vi.clearAllMocks());

describe('embedded project relay runtime', () => {
  it('does nothing when disabled even without Docker storage', () => {
    const f = fixture();
    expect(
      installEmbeddedProjectRelayRuntime({
        ...f.context,
        projectRelayEnabled: false,
        docker: undefined,
        config: {},
      }),
    ).toBeUndefined();
    expect(mkdirSync).not.toHaveBeenCalled();
    expect(createProjectRelayRuntime).not.toHaveBeenCalled();
  });

  it.each(['docker', 'dataVolume', 'dataVolumeRoot'] as const)(
    'rejects missing %s before creating socket directories',
    (missing) => {
      const f = fixture();
      if (missing === 'docker') f.context.docker = undefined;
      else f.context.config[missing] = undefined;
      expect(() => installEmbeddedProjectRelayRuntime(f.context)).toThrow(
        'project relay Docker runtime is unavailable',
      );
      expect(mkdirSync).not.toHaveBeenCalled();
    },
  );

  it('requires membership in the configured relay group', () => {
    const f = fixture();
    const groups = [...(process.getgroups?.() ?? []), process.getgid?.()];
    f.context.config.projectRelayGid =
      Math.max(65532, ...groups.filter((n): n is number => n !== undefined)) + 1;
    expect(() => installEmbeddedProjectRelayRuntime(f.context)).toThrow(
      /requires server membership/,
    );
    expect(createProjectRelayRuntime).not.toHaveBeenCalled();
  });

  it('creates private socket roots and forwards runtime dependencies', () => {
    const f = fixture();
    installEmbeddedProjectRelayRuntime(f.context);
    expect(vi.mocked(mkdirSync).mock.calls).toEqual(
      ['broker', 'claude', 'codex'].map((area) => [
        '/data/relay/' + area,
        { recursive: true, mode: 0o700 },
      ]),
    );
    expect(options()).toMatchObject({
      app: f.context.app,
      docker: f.context.docker,
      githubCapabilities: f.context.ghTokenCapabilities,
      signingCapabilities: f.context.signingCapabilities,
      image: 'relay',
      dataVolume: 'data',
      dataVolumeRoot: '/data',
      sandboxNetwork: f.context.sandboxNetworkName,
      socketOwnerUid: process.getuid?.() ?? 1000,
      relayGid: f.context.config.projectRelayGid,
      brokerSocketRoot: '/data/relay/broker',
      claudeSocketRoot: '/data/relay/claude',
      codexSocketRoot: '/data/relay/codex',
    });
  });

  it('uses GitHub authorities for non-Forgejo projects', async () => {
    const f = fixture();
    installEmbeddedProjectRelayRuntime(f.context);
    expect(await options().forgeAuthorities!('project')).toEqual([
      'github.com:443',
      'api.github.com:443',
      'uploads.github.com:443',
      'ghcr.io:443',
    ]);
    expect(f.getConnection).not.toHaveBeenCalled();
  });

  it.each(['https://forge.example', 'https://forge.example:8443'])(
    'resolves the stored Forgejo authority for %s',
    async (baseUrl) => {
      const f = fixture();
      f.getProject.mockResolvedValue({
        kind: 'forgejo',
        forgeConnectionId: 'connection',
      } as Awaited<ReturnType<EventStore['getProject']>>);
      f.getConnection.mockResolvedValue({ provider: 'forgejo', baseUrl } as Awaited<
        ReturnType<EventStore['forgeConnections']['get']>
      >);
      installEmbeddedProjectRelayRuntime(f.context);
      expect(await options().forgeAuthorities!('project')).toEqual([
        new URL(baseUrl).hostname + ':' + (new URL(baseUrl).port || '443'),
      ]);
      expect(f.getConnection).toHaveBeenCalledWith('connection');
    },
  );

  it('fails closed when the stored forge connection is unavailable', async () => {
    const f = fixture();
    f.getProject.mockResolvedValue({ kind: 'forgejo', forgeConnectionId: 'missing' } as Awaited<
      ReturnType<EventStore['getProject']>
    >);
    installEmbeddedProjectRelayRuntime(f.context);
    expect(await options().forgeAuthorities!('project')).toEqual([]);
    const failure = new Error('store unavailable');
    f.getProject.mockRejectedValue(failure);
    await expect(options().forgeAuthorities!('project')).rejects.toBe(failure);
  });
});
