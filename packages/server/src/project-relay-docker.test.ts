import { describe, expect, it, vi } from 'vitest';

import { DockerError, type DockerClient, type DockerContainerSummary } from './docker.js';
import { projectSocketBindingName } from './internal-listener.js';
import { ProjectRelayStartError } from './project-relay-lifecycle.js';
import {
  createDockerProjectRelayStarter,
  projectRelayContainerName,
} from './project-relay-docker.js';

/** One `GET /containers/json` entry, narrowed to what the relay sweep reads. */
function summary(id: string, labels: Record<string, string>): DockerContainerSummary {
  return { id, imageId: 'sha256:img', names: [id], labels, created: 0 };
}

function harness(
  options: {
    containers?: DockerContainerSummary[];
    log?: { warn: (obj: unknown, msg?: string) => void };
    relayGid?: number;
  } = {},
) {
  const createContainer = vi.fn(async () => ({ id: 'relay-cid', warnings: [] }));
  const startContainer = vi.fn(async () => {});
  const stopContainer = vi.fn(async (id: string) => void id);
  const removeContainer = vi.fn(async (id: string) => void id);
  const pullImage = vi.fn(async () => {});
  const docker = {
    createContainer,
    startContainer,
    stopContainer,
    removeContainer,
    pullImage,
    inspectContainer: vi.fn(),
    // Absent unless a case supplies state: the adapter must stay correct against
    // a client that predates the listing capability.
    ...(options.containers === undefined
      ? {}
      : { listContainers: vi.fn(async () => options.containers!) }),
  } satisfies DockerClient;
  const start = createDockerProjectRelayStarter({
    docker,
    ...(options.log === undefined ? {} : { log: options.log }),
    image: `ghcr.io/heey-global/verity/verity-project-relay@sha256:${'a'.repeat(64)}`,
    dataVolume: 'verity-data',
    dataVolumeRoot: '/srv/verity',
    brokerSocketRoot: '/srv/verity/broker',
    claudeSocketRoot: '/srv/verity/claude',
    codexSocketRoot: '/srv/verity/codex',
    socketOwnerUid: 1000,
    relayGid: options.relayGid ?? 65_532,
    projectNetwork: (projectId) => `verity-proj-${projectId}`,
    validateSocketTree: () => true,
  });
  return {
    createContainer,
    docker,
    pullImage,
    removeContainer,
    start,
    startContainer,
    stopContainer,
  };
}

const identity = { projectId: 'p1', containerGeneration: 'generation-1' };
const context = {
  identity,
  brokerSocketPath: `/srv/verity/broker/${projectSocketBindingName(identity)}/broker.sock`,
  claudeSocketPath: `/srv/verity/claude/${projectSocketBindingName(identity)}/claude.sock`,
  codexSocketPath: `/srv/verity/codex/${projectSocketBindingName(identity)}/codex.sock`,
};

describe('Docker project relay adapter', () => {
  it('creates one hardened, un-published relay on the project network', async () => {
    const h = harness();
    await h.start(context);
    expect(h.createContainer).toHaveBeenCalledWith({
      image: `ghcr.io/heey-global/verity/verity-project-relay@sha256:${'a'.repeat(64)}`,
      name: projectRelayContainerName(identity),
      network: 'verity-proj-p1',
      user: '65532:65532',
      restartPolicy: 'no',
      readOnlyRootfs: true,
      tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=1m' },
      capDrop: ['ALL'],
      securityOpt: ['no-new-privileges:true'],
      pidsLimit: 32,
      memoryBytes: 67_108_864,
      nanoCpus: 250_000_000,
      labels: {
        'verity.component': 'project-relay',
        'verity.project-id': 'p1',
        'verity.container-generation': 'generation-1',
      },
      volumeMounts: [
        {
          volume: 'verity-data',
          target: '/run/verity-relay/broker',
          subpath: `broker/${projectSocketBindingName(identity)}`,
          readOnly: true,
        },
        {
          volume: 'verity-data',
          target: '/run/verity-relay/codex',
          subpath: `codex/${projectSocketBindingName(identity)}`,
          readOnly: true,
        },
        {
          volume: 'verity-data',
          target: '/run/verity-relay/claude',
          subpath: `claude/${projectSocketBindingName(identity)}`,
          readOnly: true,
        },
      ],
    });
    expect(h.startContainer).toHaveBeenCalledWith('relay-cid');
  });

  it('adopts a running generation without creating or restarting its container', async () => {
    const h = harness();
    vi.mocked(h.docker.inspectContainer).mockResolvedValueOnce({
      id: 'existing-relay',
      running: true,
      labels: {
        'verity.component': 'project-relay',
        'verity.project-id': 'p1',
        'verity.container-generation': 'generation-1',
      },
    });
    await h.start({ ...context, resumeExisting: true });
    expect(h.createContainer).not.toHaveBeenCalled();
    expect(h.startContainer).not.toHaveBeenCalled();
  });

  it('runs the fixed relay uid with the configured socket group', async () => {
    const h = harness({ relayGid: 12_345 });
    await h.start(context);

    expect(h.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({ user: '65532:12345' }),
    );
  });

  it('pulls the fixed image once when create reports image_not_found', async () => {
    const h = harness();
    h.createContainer
      .mockRejectedValueOnce(
        new DockerError({ kind: 'image_not_found', image: 'relay', message: 'missing' }),
      )
      .mockResolvedValueOnce({ id: 'relay-cid', warnings: [] });
    await h.start(context);
    expect(h.pullImage).toHaveBeenCalledOnce();
    expect(h.createContainer).toHaveBeenCalledTimes(2);
  });

  it('removes a created relay when start fails', async () => {
    const h = harness();
    h.startContainer.mockRejectedValueOnce(new Error('start failed'));
    await expect(h.start(context)).rejects.toThrow('start failed');
    expect(h.stopContainer).toHaveBeenCalledWith('relay-cid');
    expect(h.removeContainer).toHaveBeenCalledWith('relay-cid');
  });

  it('returns a retryable runtime when start rollback cannot remove the container', async () => {
    const h = harness();
    h.startContainer.mockRejectedValueOnce(new Error('start failed'));
    h.removeContainer.mockRejectedValueOnce(new Error('daemon busy'));
    let failure: unknown;
    try {
      await h.start(context);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProjectRelayStartError);
    await (failure as ProjectRelayStartError).runtime.close();
    expect(h.removeContainer).toHaveBeenCalledTimes(2);
  });

  it('stops and force-removes the exact created container on close', async () => {
    const h = harness();
    const runtime = await h.start(context);
    await runtime.close();
    expect(h.stopContainer).toHaveBeenCalledWith('relay-cid');
    expect(h.removeContainer).toHaveBeenCalledWith('relay-cid');
  });

  it('waits for stop to finish before removing a relay', async () => {
    let finishStop: (() => void) | undefined;
    const h = harness();
    h.stopContainer.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          finishStop = () => resolve(undefined);
        }),
    );
    const runtime = await h.start(context);
    const closing = runtime.close();

    await vi.waitFor(() => expect(finishStop).toBeDefined());
    expect(h.removeContainer).not.toHaveBeenCalled();
    finishStop!();
    await closing;
    expect(h.removeContainer).toHaveBeenCalledWith('relay-cid');
  });

  it('removes this project’s earlier-generation relays once the new one is up', async () => {
    // What a control-plane restart leaves behind: `stop` could not retire the
    // previous process's relay, so the recreate must not simply run beside it.
    const h = harness({
      containers: [
        summary('relay-old', {
          'verity.component': 'project-relay',
          'verity.project-id': 'p1',
          'verity.container-generation': 'generation-0',
        }),
        summary('relay-other-project', {
          'verity.component': 'project-relay',
          'verity.project-id': 'p2',
          'verity.container-generation': 'generation-0',
        }),
        summary('relay-unstamped', {
          'verity.component': 'project-relay',
          'verity.project-id': 'p1',
        }),
        summary('relay-empty-generation', {
          'verity.component': 'project-relay',
          'verity.project-id': 'p1',
          'verity.container-generation': '',
        }),
        summary('sandbox-old', {
          'verity.project-id': 'p1',
          'verity.container-generation': 'generation-in-use',
        }),
        summary('relay-in-use', {
          'verity.component': 'project-relay',
          'verity.project-id': 'p1',
          'verity.container-generation': 'generation-in-use',
        }),
        {
          ...summary('relay-young', {
            'verity.component': 'project-relay',
            'verity.project-id': 'p1',
            'verity.container-generation': 'generation-concurrent',
          }),
          created: Math.floor(Date.now() / 1000),
        },
        summary('foreign', {}),
      ],
    });
    await h.start(context);

    expect(h.stopContainer.mock.calls.map(([id]) => id)).toEqual(['relay-old']);
    expect(h.removeContainer.mock.calls.map(([id]) => id)).toEqual(['relay-old']);
  });

  it('sweeps a relay left labelled with the pre-ADR-0013 component name', async () => {
    // The upgrade case. A relay minted before the rename carries the old label,
    // which used to put it on the sandbox side of `servedGenerations` — so it
    // vouched for its own generation and no sweep could ever reach it.
    const h = harness({
      containers: [
        summary('relay-legacy', {
          'verity.component': 'project-broker-relay',
          'verity.project-id': 'p1',
          'verity.container-generation': 'generation-0',
        }),
        summary('relay-legacy-other-project', {
          'verity.component': 'project-broker-relay',
          'verity.project-id': 'p2',
          'verity.container-generation': 'generation-0',
        }),
        summary('sandbox-still-served', {
          'verity.project-id': 'p1',
          'verity.container-generation': 'generation-in-use',
        }),
        summary('relay-legacy-in-use', {
          'verity.component': 'project-broker-relay',
          'verity.project-id': 'p1',
          'verity.container-generation': 'generation-in-use',
        }),
      ],
    });
    await h.start(context);

    expect(h.removeContainer.mock.calls.map(([id]) => id)).toEqual(['relay-legacy']);
  });

  it('never removes the relay it just started, and reports a sweep failure without failing', async () => {
    const warn = vi.fn();
    const h = harness({
      containers: [
        summary('relay-cid', {
          'verity.component': 'project-relay',
          'verity.project-id': 'p1',
          'verity.container-generation': 'generation-1',
        }),
        summary('relay-old', {
          'verity.component': 'project-relay',
          'verity.project-id': 'p1',
          'verity.container-generation': 'generation-0',
        }),
      ],
      log: { warn },
    });
    h.removeContainer.mockRejectedValueOnce(new Error('daemon busy'));

    // A cleanup failure must not turn a healthy start into a failed one.
    await expect(h.start(context)).resolves.toBeDefined();
    expect(h.removeContainer.mock.calls.map(([id]) => id)).toEqual(['relay-old']);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('is a no-op when the Docker client cannot list containers', async () => {
    const h = harness();
    await h.start(context);
    expect(h.removeContainer).not.toHaveBeenCalled();
  });

  it('refuses sockets outside the exact project-generation binding', async () => {
    const h = harness();
    await expect(
      h.start({ ...context, brokerSocketPath: '/tmp/foreign/broker.sock' }),
    ).rejects.toThrow('broker socket is not bound');
    const start = createDockerProjectRelayStarter({
      docker: h.docker,
      image: `relay@sha256:${'c'.repeat(64)}`,
      dataVolume: 'verity-data',
      dataVolumeRoot: '/srv/verity',
      brokerSocketRoot: '/srv/verity/broker',
      claudeSocketRoot: '/srv/verity/claude',
      socketOwnerUid: 1000,
      relayGid: 65_532,
      projectNetwork: () => 'network',
      validateSocketTree: () => true,
    });
    await expect(
      start({ ...context, claudeSocketPath: '/tmp/foreign/claude.sock' }),
    ).rejects.toThrow('Claude socket is not bound');
    expect(h.createContainer).not.toHaveBeenCalled();
  });

  it('refuses mutable images and untrusted or symlinked socket directories', async () => {
    const h = harness();
    const tagged = createDockerProjectRelayStarter({
      docker: h.docker,
      image: 'ghcr.io/heey-global/verity/verity-project-relay:latest',
      dataVolume: 'verity-data',
      dataVolumeRoot: '/srv/verity',
      brokerSocketRoot: '/srv/verity/broker',
      claudeSocketRoot: '/srv/verity/claude',
      socketOwnerUid: 1000,
      relayGid: 65_532,
      projectNetwork: () => 'network',
      validateSocketTree: () => true,
    });
    await expect(tagged(context)).rejects.toThrow('image must be digest-pinned');

    const untrusted = createDockerProjectRelayStarter({
      docker: h.docker,
      image: `relay@sha256:${'b'.repeat(64)}`,
      dataVolume: 'verity-data',
      dataVolumeRoot: '/srv/verity',
      brokerSocketRoot: '/srv/verity/broker',
      claudeSocketRoot: '/srv/verity/claude',
      socketOwnerUid: 1000,
      relayGid: 65_532,
      projectNetwork: () => 'network',
      validateSocketTree: () => false,
    });
    await expect(untrusted(context)).rejects.toThrow('directory is not trusted');
  });
});
