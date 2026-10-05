import { describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '@verity/store';
import type { ContainerInspect, DockerClient } from './docker.js';
import { SessionSandboxProvisioner, sessionSandboxSpec } from './session-sandbox.js';

const project = { id: 'project', containerName: 'project-container' } as ProjectRecord;
const template: ContainerInspect = {
  privileged: false,
  deviceCount: 0,
  id: 'parent',
  running: true,
  image: 'sandbox@sha256:pinned',
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
    expect(spec.volumeMounts).toEqual([]);
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
    ]);
    expect(spec.binds).not.toContain('/data/project:/work');
  });
});

describe('existing session sandbox validation', () => {
  it('rejects a labelled container retaining the project workspace', async () => {
    const startContainer = vi.fn();
    const docker = {
      inspectContainer: vi.fn(async (name: string) =>
        name === project.containerName
          ? template
          : {
              ...template,
              labels: { 'verity.session-id': 'session', 'verity.project-id': project.id },
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
