import { describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '@verity/store';
import { DockerError, type ContainerInspect, type DockerClient } from './docker.js';
import { projectRelayContainerName } from './project-relay-identity.js';
import { defaultProjectRelay } from './provisioner.test-helper.js';
import {
  RetainedResumeError,
  resumeRetainedSandbox,
  type RetainedResumeHost,
} from './sandbox-retained-resume.js';

const project = { id: 'p', containerName: 'dev-p' } as ProjectRecord;
const inspect: ContainerInspect = { id: 'cid', running: false };

function host(reactivate: NonNullable<RetainedResumeHost['opts']['projectRelay']['reactivate']>) {
  const startContainer = vi.fn(async () => undefined);
  const stopContainer = vi.fn(async () => undefined);
  const docker = {
    startContainer,
    stopContainer,
    inspectContainer: vi.fn(async () => ({ id: 'cid', running: true })),
  } as unknown as DockerClient;
  const reactivateSpy = vi.fn(reactivate);
  const sleep = vi.fn(async () => undefined);
  const sandboxStarted = vi.fn();
  const relay = { ...defaultProjectRelay(), reactivate: reactivateSpy, sleep };
  const value: RetainedResumeHost = {
    opts: { docker, projectRelay: relay } as unknown as RetainedResumeHost['opts'],
    containerCommand: vi.fn(),
    relayBinding: async () => ({}) as never,
    rewriteMountedSecretFile: vi.fn(),
    chownRunnerFile: vi.fn(),
    supervisorReachable: vi.fn(async () => undefined),
    sandboxStarted,
    notifyRunnerReady: vi.fn(),
  };
  return { value, startContainer, stopContainer, reactivate: reactivateSpy, sleep, sandboxStarted };
}

describe('resumeRetainedSandbox', () => {
  it('starts the retained container after its relay generation is awake', async () => {
    const h = host(async () => ({
      identity: { projectId: 'p', userId: 'u', projectDefault: true, containerGeneration: 'g1' },
      signingCapability: 's',
      githubCapability: 'g',
    }));
    await resumeRetainedSandbox(h.value, {
      project,
      inspect,
      generation: 'g1',
      egress: undefined,
      commit: async () => undefined,
    });
    expect(h.reactivate).toHaveBeenCalledOnce();
    expect(h.startContainer).toHaveBeenCalledWith('cid');
    expect(h.sandboxStarted).toHaveBeenCalledWith(project);
  });

  // A relay removed while its generation slept can never be reactivated; the caller
  // must learn that, not just "failed", to replace the Sandbox instead of retrying.
  it('reports a missing relay generation and stops the container again', async () => {
    const h = host(async () => {
      throw new DockerError({
        kind: 'container_not_found',
        id: projectRelayContainerName({ projectId: 'p', containerGeneration: 'g1' }),
      });
    });
    const error = await resumeRetainedSandbox(h.value, {
      project,
      inspect,
      generation: 'g1',
      egress: undefined,
      commit: async () => undefined,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RetainedResumeError);
    expect((error as RetainedResumeError).relayMissing).toBe(true);
    expect((error as RetainedResumeError).cleanupFailures).toEqual([]);
    expect(h.startContainer).not.toHaveBeenCalled();
    expect(h.stopContainer).toHaveBeenCalledWith('dev-p');
    // Never awake, so there is nothing to put back to sleep.
    expect(h.sleep).not.toHaveBeenCalled();
  });

  // Recording the Sandbox as running is part of the resume: if that write fails,
  // a started container with an awake relay must not outlive a store that still
  // says it sleeps.
  it('rolls the start back when recording it fails', async () => {
    const h = host(async () => ({
      identity: { projectId: 'p', userId: 'u', projectDefault: true, containerGeneration: 'g1' },
      signingCapability: 's',
      githubCapability: 'g',
    }));
    const error = await resumeRetainedSandbox(h.value, {
      project,
      inspect,
      generation: 'g1',
      egress: undefined,
      commit: async () => {
        throw new Error('store unavailable');
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RetainedResumeError);
    expect(h.startContainer).toHaveBeenCalledWith('cid');
    expect(h.stopContainer).toHaveBeenCalledWith('dev-p');
    expect(h.sleep).toHaveBeenCalledOnce();
  });
});
