import { describe, expect, it, vi } from 'vitest';

import type {
  ContainerInspect,
  ContainerSpec,
  DockerClient,
  DockerRuntimeRegistration,
} from './docker.js';
import { DockerError } from './docker.js';
import type {
  GvisorSandboxChannelRun,
  GvisorSandboxChannelRunInput,
} from './docker-gvisor-sandbox-channel.js';
import {
  createDockerGvisorSandboxLauncher,
  type SecretJobChannelBinding,
} from './docker-gvisor-sandbox-launcher.js';
import type { LaunchedSandbox, SandboxLaunchSpec } from './secret-job-executor.js';

const digest = 'e'.repeat(64);
const runtimeOptions = {
  expectedRuntimePath: '/opt/verity/runsc/release-20260714.0/runsc',
  expectedRuntimeArgs: ['--platform=systrap', '--network=none'],
} as const;
const spec: SandboxLaunchSpec = {
  jobId: 'job-1',
  runtime: 'docker-gvisor',
  executorImageDigest: digest,
  profileId: 'profile-1',
  profileVersion: 2,
  policyHash: 'a'.repeat(64),
  absoluteDeadline: new Date(Date.now() + 10 * 60_000).toISOString(),
};

const WORKLOAD = {
  executorInstanceId: 'executor-1',
  jobId: 'job-1',
  publicKeyId: 'key-1',
  attestationHash: 'b'.repeat(64),
} as const;

async function* noFrames(): AsyncGenerator<never> {
  // Deliberately empty.
}

/** A fake channel run that authenticated successfully — returns the workload plus frames/result. */
function fakeRun(overrides: Partial<Pick<GvisorSandboxChannelRun, 'frames' | 'result'>> = {}) {
  return vi.fn((input: GvisorSandboxChannelRunInput): Promise<GvisorSandboxChannelRun> => {
    void input;
    return Promise.resolve({
      workload: { ...WORKLOAD },
      frames: overrides.frames ?? noFrames(),
      result: overrides.result ?? new Promise<never>(() => undefined),
    });
  });
}

function claims(): SecretJobChannelBinding['claims'] {
  return {
    protocolVersion: 1,
    grantId: 'grant-1',
    requestHash: 'a'.repeat(64),
    projectId: 'project-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'tool-call-1',
    profile: { id: 'kubernetes-read', version: 1, policyHash: 'b'.repeat(64) },
    aliases: [{ id: 'alias-1', version: 1 }],
    providerBindings: [{ id: 'binding-1', version: 1, provider: 'doppler' }],
    audience: 'verity-secret-job-executor',
    issuedAt: '2026-07-19T00:00:00Z',
    expiresAt: '2026-07-19T00:05:00Z',
    nonce: 'n'.repeat(32),
  };
}

/** A fake per-job resolver; its `sealEnvelope` is never invoked because the fake run ignores it. */
function fakeResolveSecretJob() {
  return vi.fn((): Promise<SecretJobChannelBinding> =>
    Promise.resolve({
      claims: claims(),
      sealEnvelope: () => Promise.reject(new Error('sealEnvelope not used in this test')),
    }),
  );
}

function fakeDocker() {
  const specs: ContainerSpec[] = [];
  const createContainer = vi.fn(async (containerSpec: ContainerSpec) => {
    specs.push(containerSpec);
    return { id: 'container-1', warnings: [] };
  });
  const startContainer = vi.fn(async (id: string) => void id);
  const stopContainer = vi.fn(async (id: string) => void id);
  const removeContainer = vi.fn(async (id: string) => void id);
  const inspectContainer = vi.fn<(id: string) => Promise<ContainerInspect>>();
  const inspectRuntime = vi.fn(async (): Promise<DockerRuntimeRegistration> => ({
    path: runtimeOptions.expectedRuntimePath,
    args: [...runtimeOptions.expectedRuntimeArgs],
  }));
  return {
    client: {
      createContainer,
      startContainer,
      stopContainer,
      removeContainer,
      inspectContainer,
      inspectRuntime,
    } as unknown as DockerClient,
    specs,
    createContainer,
    startContainer,
    stopContainer,
    removeContainer,
    inspectContainer,
    inspectRuntime,
  };
}

function inspectFromSpec(
  original: ContainerSpec,
  overrides: Partial<ContainerInspect> = {},
): ContainerInspect {
  return {
    id: 'container-1',
    running: true,
    status: 'running',
    image: original.image,
    runtime: original.runtime,
    labels: original.labels,
    networkMode: original.network,
    readOnlyRootfs: original.readOnlyRootfs,
    tmpfs: original.tmpfs,
    capDrop: original.capDrop,
    securityOpt: original.securityOpt,
    pidsLimit: original.pidsLimit,
    memoryBytes: original.memoryBytes,
    nanoCpus: original.nanoCpus,
    env: original.env,
    mountCount: 0,
    privileged: false,
    capAdd: original.capAdd ?? [],
    deviceCount: 0,
    restartPolicy: original.restartPolicy,
    user: original.user,
    entrypoint: original.entrypoint,
    command: original.command,
    ...(original.openStdin !== undefined ? { openStdin: original.openStdin } : {}),
    init: true,
    ...overrides,
  };
}

describe('Docker gVisor sandbox launcher', () => {
  it('launches a secret-free, hardened container and drives it through the channel', async () => {
    const docker = fakeDocker();
    const run = fakeRun();
    const resolveSecretJob = fakeResolveSecretJob();
    const launcher = createDockerGvisorSandboxLauncher({
      docker: docker.client,
      channel: { run },
      resolveSecretJob,
      ...runtimeOptions,
      executorImageRepository: 'ghcr.io/heey-global/verity-secret-executor',
    });

    await expect(launcher.launch(spec)).resolves.toMatchObject({
      workload: { executorInstanceId: 'executor-1', jobId: 'job-1' },
    });
    expect(docker.inspectRuntime).toHaveBeenCalledWith('runsc');
    expect(docker.specs).toHaveLength(1);
    expect(docker.specs[0]).toMatchObject({
      image: `ghcr.io/heey-global/verity-secret-executor@sha256:${digest}`,
      runtime: 'runsc',
      network: 'none',
      readOnlyRootfs: true,
      restartPolicy: 'no',
      capDrop: ['ALL'],
      securityOpt: ['no-new-privileges:true'],
      pidsLimit: 128,
      memoryBytes: 512 * 1024 * 1024,
      nanoCpus: 1_000_000_000,
      env: [],
      user: '65532:65532',
      entrypoint: ['/usr/local/bin/verity-secret-job-worker'],
      command: [],
      openStdin: true,
    });
    // The secret-free-spec invariant: no capability, claims, or secret bytes in the create request.
    expect(JSON.stringify(docker.specs[0])).not.toContain('capability');
    expect(JSON.stringify(docker.specs[0])).not.toContain('grant-1');
    expect(JSON.stringify(docker.specs[0])).not.toContain('fake-secret-value');
    expect(docker.startContainer).toHaveBeenCalledWith('container-1');
    expect(resolveSecretJob).toHaveBeenCalledWith('job-1');
    // The resolved binding and the session abort signal must be forwarded verbatim to the channel.
    const runInput = run.mock.calls[0]?.[0];
    expect(runInput).toMatchObject({
      jobId: 'job-1',
      containerId: 'container-1',
      claims: { grantId: 'grant-1' },
    });
    expect(runInput?.signal).toBeInstanceOf(AbortSignal);
    expect(typeof runInput?.sealEnvelope).toBe('function');
  });

  it('aborts the channel session when the deadline fires', async () => {
    const docker = fakeDocker();
    let captured: AbortSignal | undefined;
    let expire: (() => void) | undefined;
    const run = vi.fn((input: GvisorSandboxChannelRunInput): Promise<GvisorSandboxChannelRun> => {
      captured = input.signal;
      return Promise.resolve({
        workload: { ...WORKLOAD },
        frames: noFrames(),
        result: new Promise<never>(() => undefined),
      });
    });
    const launcher = createDockerGvisorSandboxLauncher({
      docker: docker.client,
      channel: { run },
      resolveSecretJob: fakeResolveSecretJob(),
      ...runtimeOptions,
      executorImageRepository: 'executor',
      now: () => new Date('2026-07-20T11:59:59.000Z'),
      scheduleDeadline(callback) {
        expire = callback;
        return { cancel: vi.fn() };
      },
    });

    await launcher.launch({ ...spec, absoluteDeadline: '2026-07-20T12:00:00.000Z' });
    expect(captured?.aborted).toBe(false);
    expire?.();
    expect(captured?.aborted).toBe(true); // the deadline tears down the channel session
  });

  it('fails closed before container creation when runsc verification fails', async () => {
    const docker = fakeDocker();
    docker.inspectRuntime.mockResolvedValueOnce({ path: '/usr/bin/runc', args: [] });
    const launcher = createDockerGvisorSandboxLauncher({
      docker: docker.client,
      channel: { run: fakeRun() },
      resolveSecretJob: fakeResolveSecretJob(),
      ...runtimeOptions,
      executorImageRepository: 'executor',
    });

    await expect(launcher.launch(spec)).rejects.toThrow(/path mismatch/);
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it('removes a created container when start or the channel run fails', async () => {
    const docker = fakeDocker();
    const launcher = createDockerGvisorSandboxLauncher({
      docker: docker.client,
      channel: { run: vi.fn(() => Promise.reject(new Error('worker authentication failed'))) },
      resolveSecretJob: fakeResolveSecretJob(),
      ...runtimeOptions,
      executorImageRepository: 'executor',
    });

    await expect(launcher.launch(spec)).rejects.toThrow(/authentication failed/);
    expect(docker.removeContainer).toHaveBeenCalledWith('container-1');
  });

  it('removes the created container when the per-job secret binding cannot be resolved', async () => {
    const docker = fakeDocker();
    const run = fakeRun();
    const launcher = createDockerGvisorSandboxLauncher({
      docker: docker.client,
      channel: { run },
      resolveSecretJob: vi.fn(() => Promise.reject(new Error('grant unavailable'))),
      ...runtimeOptions,
      executorImageRepository: 'executor',
    });

    await expect(launcher.launch(spec)).rejects.toThrow(/grant unavailable/);
    expect(docker.removeContainer).toHaveBeenCalledWith('container-1');
    expect(run).not.toHaveBeenCalled(); // never drove a channel without a resolved binding
  });

  it('adopts an identical running container after a controller restart', async () => {
    const docker = fakeDocker();
    const options = {
      docker: docker.client,
      channel: { run: fakeRun() },
      resolveSecretJob: fakeResolveSecretJob(),
      ...runtimeOptions,
      executorImageRepository: 'executor',
    };
    await createDockerGvisorSandboxLauncher(options).launch(spec);
    const original = docker.specs[0];
    if (original === undefined) throw new Error('missing original container spec');

    docker.createContainer.mockRejectedValueOnce(
      new DockerError({ kind: 'conflict', message: 'name already in use' }),
    );
    docker.inspectContainer.mockResolvedValueOnce(inspectFromSpec(original));
    docker.startContainer.mockClear();

    await expect(createDockerGvisorSandboxLauncher(options).launch(spec)).resolves.toMatchObject({
      workload: { executorInstanceId: 'executor-1', jobId: 'job-1' },
    });
    expect(docker.inspectContainer).toHaveBeenCalledWith(original.name);
    expect(docker.startContainer).not.toHaveBeenCalled();
  });

  it('refuses copied labels when the inspected container hardening differs', async () => {
    const docker = fakeDocker();
    const options = {
      docker: docker.client,
      channel: { run: fakeRun() },
      resolveSecretJob: fakeResolveSecretJob(),
      ...runtimeOptions,
      executorImageRepository: 'executor',
    };
    await createDockerGvisorSandboxLauncher(options).launch(spec);
    const original = docker.specs[0];
    if (original === undefined) throw new Error('missing original container spec');
    docker.createContainer.mockRejectedValueOnce(
      new DockerError({ kind: 'conflict', message: 'name already in use' }),
    );
    docker.inspectContainer.mockResolvedValueOnce(
      inspectFromSpec(original, { id: 'attacker-container', privileged: true }),
    );
    docker.startContainer.mockClear();

    await expect(createDockerGvisorSandboxLauncher(options).launch(spec)).rejects.toThrow(
      /does not match/,
    );
    expect(docker.startContainer).not.toHaveBeenCalled();
  });

  it('never restarts an adopted container that already exited', async () => {
    const docker = fakeDocker();
    const options = {
      docker: docker.client,
      channel: { run: fakeRun() },
      resolveSecretJob: fakeResolveSecretJob(),
      ...runtimeOptions,
      executorImageRepository: 'executor',
    };
    await createDockerGvisorSandboxLauncher(options).launch(spec);
    const original = docker.specs[0];
    if (original === undefined) throw new Error('missing original container spec');
    docker.createContainer.mockRejectedValueOnce(
      new DockerError({ kind: 'conflict', message: 'name already in use' }),
    );
    docker.inspectContainer.mockResolvedValueOnce(
      inspectFromSpec(original, { running: false, status: 'exited' }),
    );
    docker.startContainer.mockClear();

    await expect(createDockerGvisorSandboxLauncher(options).launch(spec)).rejects.toThrow(
      /cannot be restarted/,
    );
    expect(docker.startContainer).not.toHaveBeenCalled();
  });

  it('tears down by deterministic name and reports an already absent container', async () => {
    const docker = fakeDocker();
    const launcher = createDockerGvisorSandboxLauncher({
      docker: docker.client,
      channel: { run: fakeRun() },
      resolveSecretJob: fakeResolveSecretJob(),
      ...runtimeOptions,
      executorImageRepository: 'executor',
    });

    await expect(launcher.teardown('job-1')).resolves.toBe('reaped');
    const name = docker.removeContainer.mock.calls[0]?.[0];
    expect(name).toMatch(/^verity-secret-job-[a-f0-9]{24}$/);
    expect(docker.removeContainer).toHaveBeenCalledWith(name);

    docker.removeContainer.mockRejectedValueOnce(
      new DockerError({ kind: 'container_not_found', id: String(name) }),
    );
    await expect(launcher.teardown('job-1')).resolves.toBe('already_reaped');
  });

  it('force-removes the worker and returns deadline_exceeded at the absolute deadline', async () => {
    const docker = fakeDocker();
    let expire: (() => void) | undefined;
    const cancel = vi.fn();
    const launcher = createDockerGvisorSandboxLauncher({
      docker: docker.client,
      channel: { run: fakeRun() },
      resolveSecretJob: fakeResolveSecretJob(),
      ...runtimeOptions,
      executorImageRepository: 'executor',
      now: () => new Date('2026-07-20T11:59:59.000Z'),
      scheduleDeadline(callback, delayMs) {
        expect(delayMs).toBe(1_000);
        expire = callback;
        return { cancel };
      },
    });

    const sandbox = await launcher.launch({
      ...spec,
      absoluteDeadline: '2026-07-20T12:00:00.000Z',
    });
    if (expire === undefined) throw new Error('deadline was not scheduled');
    expire();

    await expect(sandbox.result).resolves.toMatchObject({
      jobId: 'job-1',
      outcome: 'deadline_exceeded',
      finishedAt: '2026-07-20T12:00:00.000Z',
    });
    expect(docker.removeContainer).toHaveBeenCalledWith('container-1');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('reaps and rejects launch when the channel run hangs past the deadline', async () => {
    const docker = fakeDocker();
    docker.removeContainer.mockImplementation(async () => new Promise<never>(() => undefined));
    let expire: (() => void) | undefined;
    const launcher = createDockerGvisorSandboxLauncher({
      docker: docker.client,
      channel: { run: vi.fn(() => new Promise<never>(() => undefined)) },
      resolveSecretJob: fakeResolveSecretJob(),
      ...runtimeOptions,
      executorImageRepository: 'executor',
      now: () => new Date('2026-07-20T11:59:59.000Z'),
      scheduleDeadline(callback) {
        expire = callback;
        return { cancel: vi.fn() };
      },
    });

    const launch = launcher.launch({
      ...spec,
      absoluteDeadline: '2026-07-20T12:00:00.000Z',
    });
    await vi.waitFor(() => expect(expire).toBeDefined());
    expire?.();

    await expect(launch).rejects.toThrow(/deadline exceeded/);
    expect(docker.removeContainer).toHaveBeenCalledWith('container-1');
  });

  it('never starts when the deadline expires during runtime verification or create', async () => {
    const docker = fakeDocker();
    let calls = 0;
    const launcher = createDockerGvisorSandboxLauncher({
      docker: docker.client,
      channel: { run: fakeRun() },
      resolveSecretJob: fakeResolveSecretJob(),
      ...runtimeOptions,
      executorImageRepository: 'executor',
      now: () => new Date(calls++ === 0 ? '2026-07-20T11:59:59.000Z' : '2026-07-20T12:00:00.000Z'),
    });

    await expect(
      launcher.launch({ ...spec, absoluteDeadline: '2026-07-20T12:00:00.000Z' }),
    ).rejects.toThrow(/deadline exceeded before start/);
    expect(docker.startContainer).not.toHaveBeenCalled();
    expect(docker.removeContainer).toHaveBeenCalledWith('container-1');
  });

  it('lets the deadline win while Docker removal is still pending', async () => {
    const docker = fakeDocker();
    let expire: (() => void) | undefined;
    let finishWorker!: (result: Awaited<LaunchedSandbox['result']>) => void;
    const workerResult = new Promise<Awaited<LaunchedSandbox['result']>>((resolve) => {
      finishWorker = resolve;
    });
    docker.removeContainer.mockImplementationOnce(async () => new Promise<never>(() => undefined));
    const launcher = createDockerGvisorSandboxLauncher({
      docker: docker.client,
      channel: { run: fakeRun({ result: workerResult }) },
      resolveSecretJob: fakeResolveSecretJob(),
      ...runtimeOptions,
      executorImageRepository: 'executor',
      now: () => new Date('2026-07-20T11:59:59.000Z'),
      scheduleDeadline(callback) {
        expire = callback;
        return { cancel: vi.fn() };
      },
    });
    const sandbox = await launcher.launch({
      ...spec,
      absoluteDeadline: '2026-07-20T12:00:00.000Z',
    });
    expire?.();
    finishWorker({
      protocolVersion: 1,
      jobId: 'job-1',
      outcome: 'succeeded',
      finishedAt: '2026-07-20T12:00:00.001Z',
    });

    await expect(sandbox.result).resolves.toMatchObject({ outcome: 'deadline_exceeded' });
  });

  it('ends a non-cooperative frame stream at the deadline', async () => {
    const docker = fakeDocker();
    let expire: (() => void) | undefined;
    const hangingFrames: LaunchedSandbox['frames'] = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => new Promise<never>(() => undefined),
        };
      },
    };
    const launcher = createDockerGvisorSandboxLauncher({
      docker: docker.client,
      channel: { run: fakeRun({ frames: hangingFrames }) },
      resolveSecretJob: fakeResolveSecretJob(),
      ...runtimeOptions,
      executorImageRepository: 'executor',
      now: () => new Date('2026-07-20T11:59:59.000Z'),
      scheduleDeadline(callback) {
        expire = callback;
        return { cancel: vi.fn() };
      },
    });
    const sandbox = await launcher.launch({
      ...spec,
      absoluteDeadline: '2026-07-20T12:00:00.000Z',
    });
    const next = sandbox.frames[Symbol.asyncIterator]().next();
    expire?.();

    await expect(next).resolves.toMatchObject({ done: true });
    await expect(sandbox.result).resolves.toMatchObject({ outcome: 'deadline_exceeded' });
  });

  it('rejects every runtime other than docker-gvisor without fallback', async () => {
    const docker = fakeDocker();
    const launcher = createDockerGvisorSandboxLauncher({
      docker: docker.client,
      channel: { run: fakeRun() },
      resolveSecretJob: fakeResolveSecretJob(),
      ...runtimeOptions,
      executorImageRepository: 'executor',
    });

    await expect(launcher.launch({ ...spec, runtime: 'firecracker' })).rejects.toThrow(
      /cannot launch runtime/,
    );
    expect(docker.createContainer).not.toHaveBeenCalled();
  });
});
