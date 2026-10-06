import { describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '@verity/store';
import { DockerError, type ContainerInspect, type DockerClient } from './docker.js';
import {
  SessionSandboxProvisioner,
  sessionSandboxSpec,
  sessionNodeModulesVolumeName,
} from './session-sandbox.js';

const project = { id: 'project', containerName: 'project-container' } as ProjectRecord;
const template: ContainerInspect = {
  privileged: false,
  deviceCount: 0,
  id: 'parent',
  running: true,
  image: 'sandbox:latest',
  imageId: 'sha256:new-image',
  ulimits: [{ name: 'core', soft: 0, hard: 0 }],
  mounts: [
    { type: 'bind', source: '/data/project', destination: '/work', readWrite: true },
    { type: 'bind', source: '/data/runner', destination: '/run/verity-runner', readWrite: true },
    {
      type: 'volume',
      name: 'project-dependencies',
      destination: '/work/node_modules',
      readWrite: true,
    },
    { type: 'bind', source: '/opt/toolkit', destination: '/opt/agent-seed', readWrite: false },
  ],
  env: ['PATH=/opt/agent-seed/bin:/usr/bin', 'VERITY_SESSION_ID=other'],
};

describe('isolated session launch contract', () => {
  it('replaces every writable project mount with the private checkout', () => {
    const spec = sessionSandboxSpec(template, {
      project,
      sessionId: 'session',
      worktree: '/data/sessions/session',
    });
    expect(spec.binds).toEqual(['/opt/toolkit:/opt/agent-seed:ro', '/data/sessions/session:/work']);
    expect(spec.volumeMounts).toEqual([
      { volume: sessionNodeModulesVolumeName('session'), target: '/work/node_modules' },
    ]);
    expect(spec.env).toContain('VERITY_ISOLATED_SESSION_ID=session');
    expect(spec.env).not.toContain('VERITY_SESSION_ID=other');
    expect(spec.capDrop).toEqual(['ALL']);
  });
  it('preserves additional infrastructure networks without repeating the primary network', () => {
    const spec = sessionSandboxSpec(
      {
        ...template,
        networkMode: 'primary',
        networks: { primary: {}, gateway: {} },
      },
      { project, sessionId: 'session', worktree: '/data/sessions/session' },
    );
    expect(spec.network).toBe('primary');
    expect(spec.additionalNetworks).toEqual(['gateway']);
  });
  it('rejects a devcontainer mount exposing the project parent', () => {
    expect(() =>
      sessionSandboxSpec(
        {
          ...template,
          mounts: [
            ...template.mounts!,
            {
              type: 'bind',
              source: '/data',
              destination: '/host',
              readWrite: true,
            },
          ],
        },
        { project, sessionId: 'session', worktree: '/data/sessions/session' },
      ),
    ).toThrow('Unsupported shared sandbox mount');
  });
  it('rejects unreviewed read-only mounts that could expose other sessions', () => {
    expect(() =>
      sessionSandboxSpec(
        {
          ...template,
          mounts: [
            ...template.mounts!,
            {
              type: 'bind',
              source: '/data',
              destination: '/other-sessions',
              readWrite: false,
            },
          ],
        },
        { project, sessionId: 'session', worktree: '/data/sessions/session' },
      ),
    ).toThrow('Unsupported shared sandbox mount');
  });
  it('keeps a private named-volume workspace confined to its subpath', () => {
    const spec = sessionSandboxSpec(template, {
      project,
      sessionId: 'session',
      worktree: '/data/sessions/session',
      workspaceMount: { volume: 'data', target: '/work', subpath: 'sessions/session' },
    });
    expect(spec.volumeMounts).toEqual([
      { volume: 'data', target: '/work', subpath: 'sessions/session' },
      { volume: sessionNodeModulesVolumeName('session'), target: '/work/node_modules' },
    ]);
    expect(spec.binds).not.toContain('/data/project:/work');
  });
});

describe('existing session sandbox validation', () => {
  it('rejects a labelled container retaining the project workspace', async () => {
    const startContainer = vi.fn();
    const docker = {
      ensureVolume: vi.fn(async () => ({ mountpoint: undefined })),
      inspectContainer: vi.fn(async (name: string) =>
        name === project.containerName
          ? template
          : {
              ...template,
              labels: sessionSandboxSpec(template, {
                project,
                sessionId: 'session',
                worktree: '/data/private/session',
                runtimeBinds: ['/data/runners/session-session:/run/verity-runner'],
              }).labels,
              privileged: false,
              deviceCount: 0,
              capDrop: ['ALL'],
              capAdd: [],
              securityOpt: ['no-new-privileges:true'],
              env: ['VERITY_ISOLATED_SESSION_ID=session'],
            },
      ),
      startContainer,
    } as unknown as DockerClient;
    const provisioner = new SessionSandboxProvisioner({
      docker,
      dataVolumeRoot: '/data',
      prepareRuntime: async () => ({}),
      bootstrap: async () => undefined,
    });
    await expect(
      provisioner.ensure(project, { sessionId: 'session', worktree: '/data/private/session' }),
    ).rejects.toThrow('Session sandbox mount contract mismatch');
    expect(startContainer).not.toHaveBeenCalled();
  });
});

it('preserves inherited post-start and initializes the private gated workspace', async () => {
  const command = [
    'while [ ! -f /tmp/verity-post-create-complete ]; do sleep 0.1; done; exec post-start',
  ];
  const createContainer = vi.fn<DockerClient['createContainer']>(async () => ({
    id: 'private-id',
    warnings: [],
  }));
  const bootstrap = vi.fn(async () => undefined);
  const provisioner = new SessionSandboxProvisioner({
    docker: {
      ensureVolume: vi.fn(async () => ({ mountpoint: undefined })),
      inspectContainer: vi.fn(async (name: string) => {
        if (name === project.containerName) return { ...template, command };
        throw new DockerError({ kind: 'container_not_found', id: name });
      }),
      createContainer,
      startContainer: vi.fn(async () => undefined),
    } as unknown as DockerClient,
    dataVolumeRoot: '/data',
    prepareRuntime: async () => ({}),
    bootstrap,
  });
  const runtime = await provisioner.ensure(
    { ...project, state: 'sleeping' },
    { sessionId: 'session', worktree: '/data/private/session' },
  );
  expect(runtime.state).toBe('active');
  expect(createContainer.mock.calls[0]?.[0]).toMatchObject({ command });
  expect(bootstrap).toHaveBeenCalledWith(
    expect.objectContaining({ containerName: expect.stringContaining('verity-session-') }),
    '/data/runners/session-session',
    { path: '/data/private/session', waitForPostCreate: true, freshContainer: true },
  );
});

it.each([true, false])(
  'recreates an owned container after a project rebuild (running=%s)',
  async (running) => {
    const desired = sessionSandboxSpec(template, {
      project,
      sessionId: 'session',
      worktree: '/data/private/session',
      runtimeBinds: ['/data/runners/session-session:/run/verity-runner'],
    });
    const docker = {
      ensureVolume: vi.fn(async () => ({ mountpoint: undefined })),
      inspectContainer: vi.fn(async (name: string) =>
        name === project.containerName
          ? template
          : { ...template, running, imageId: 'sha256:old-image', labels: desired.labels },
      ),
      stopContainer: vi.fn(async () => {
        if (!running) throw new Error('Docker HTTP 304: already stopped');
      }),
      removeContainer: vi.fn(async () => undefined),
      createContainer: vi.fn(async () => ({ id: 'new', warnings: [] })),
      startContainer: vi.fn(async () => undefined),
    };
    const bootstrap = vi.fn(async () => undefined);
    const provisioner = new SessionSandboxProvisioner({
      docker,
      dataVolumeRoot: '/data',
      prepareRuntime: async () => ({}),
      bootstrap,
    });
    await provisioner.ensure(project, { sessionId: 'session', worktree: '/data/private/session' });
    expect(docker.stopContainer).toHaveBeenCalledTimes(running ? 1 : 0);
    expect(docker.removeContainer).toHaveBeenCalledOnce();
    expect(docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        image: template.imageId,
        ulimits: [{ name: 'core', soft: 0, hard: 0 }],
        binds: expect.arrayContaining(['/data/private/session:/work']),
      }),
    );
    expect(bootstrap).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ freshContainer: true }),
    );
  },
);

it('enforces no-new-privileges even when the template contains an empty security option list', () => {
  const spec = sessionSandboxSpec(
    { ...template, securityOpt: [] },
    { project, sessionId: 'one', worktree: '/data/one' },
  );
  expect(spec.securityOpt).toContain('no-new-privileges:true');
});

it('accepts Docker-normalized capabilities and recreates a session with canonical names', () => {
  const spec = sessionSandboxSpec(
    { ...template, capAdd: ['CAP_CHOWN', 'CAP_SETUID', 'CAP_SETGID', 'CAP_KILL', 'CAP_SETPCAP'] },
    { project, sessionId: 'one', worktree: '/data/one' },
  );
  expect(spec.capAdd).toEqual(['CHOWN', 'SETUID', 'SETGID', 'KILL', 'SETPCAP']);
  expect(() =>
    sessionSandboxSpec(
      { ...template, capAdd: ['CAP_SYS_ADMIN'] },
      { project, sessionId: 'one', worktree: '/data/one' },
    ),
  ).toThrow('cannot safely');
});

it('reuses a container reported with normalized Docker capability names', async () => {
  const parent = { ...template, capAdd: ['CAP_CHOWN'] };
  const spec = sessionSandboxSpec(parent, {
    project,
    sessionId: 'session',
    worktree: '/data/private/session',
    runtimeBinds: ['/data/runners/session-session:/run/verity-runner'],
  });
  const current = {
    ...parent,
    labels: spec.labels,
    env: spec.env,
    capAdd: ['CAP_CHOWN'],
    capDrop: ['CAP_ALL'],
    securityOpt: spec.securityOpt,
    mounts: [
      ...(spec.binds ?? []).map((bind) => {
        const [source, destination, mode] = bind.split(':');
        return { type: 'bind' as const, source, destination, readWrite: mode !== 'ro' };
      }),
      ...(spec.volumeMounts ?? []).map((mount) => ({
        type: 'volume' as const,
        name: mount.volume,
        destination: mount.target,
        subpath: mount.subpath,
        readWrite: !mount.readOnly,
      })),
    ],
  };
  const createContainer = vi.fn();
  const docker = {
    ensureVolume: async () => ({ mountpoint: undefined }),
    inspectContainer: async (name: string) => (name === project.containerName ? parent : current),
    createContainer,
    startContainer: vi.fn(),
  } as unknown as DockerClient;
  const bootstrap = vi.fn(async () => undefined);
  await new SessionSandboxProvisioner({
    docker,
    dataVolumeRoot: '/data',
    prepareRuntime: async () => ({}),
    bootstrap,
  }).ensure(project, { sessionId: 'session', worktree: '/data/private/session' });
  expect(createContainer).not.toHaveBeenCalled();
  expect(bootstrap).toHaveBeenCalledOnce();
});
