import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '@verity/store';
import { ProvisionerImpl, type ProvisionerOptions } from './provisioner.js';
import { DeprovisionerImpl } from './deprovisioner.js';
import { createEmbeddedProvisioning } from './embedded-provisioning.js';
import { projectForgeProvider } from './project-forge-provider.js';

vi.mock('./provisioner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./provisioner.js')>()),
  ProvisionerImpl: vi.fn(function () {}),
}));
vi.mock('./deprovisioner.js', () => ({ DeprovisionerImpl: vi.fn(function () {}) }));
vi.mock('./project-forge-provider.js', () => ({ projectForgeProvider: vi.fn() }));

type Context = Parameters<typeof createEmbeddedProvisioning>[0];
const project = { id: 'project' } as ProjectRecord;

function fixture() {
  let current: Context['runtime'] | undefined;
  const context = {
    config: {},
    hostCloneRoot: '/dev',
    dockerBaseUrl: 'http://docker',
    buildStorage: { root: '/data/build-storage' },
    eventStore: { getVeritySettingsRaw: vi.fn(), getVeritySettings: vi.fn() },
    docker: {},
    defaultProjectImage: 'sandbox',
    secretRoot: '/data/secrets',
    ghTokenCapabilities: {},
    signingCapabilities: {},
    forgeProxyEnabled: () => true,
    withPreviewProjectMutation: vi.fn(
      async <T>(_id: string, mutation: () => Promise<T>, beforeRetire?: () => Promise<void>) => {
        await beforeRetire?.();
        return mutation();
      },
    ),
    baseMintOpts: { resolveCreds: async () => undefined },
    projectSandboxLifecycleTelemetry: { record: vi.fn() },
    runtime: new Proxy({} as Context['runtime'], {
      get(_target, key: keyof Context['runtime']) {
        if (current === undefined) throw new Error('runtime is not initialized');
        return current[key];
      },
    }),
  } as unknown as Context;
  const runtime = () => ({
    log: { warn: vi.fn(), info: vi.fn() },
    runPendingCleanup: vi.fn(async () => undefined),
    projectTurnReconciler: vi.fn(async () => undefined),
    listenerDiscovery: { invalidateProject: vi.fn() },
    projectAgentGatewayIdentity: vi.fn(async () => undefined),
  });
  const installRuntime = () => {
    const next = runtime();
    current = next as unknown as Context['runtime'];
    return next;
  };
  return { context, installRuntime };
}
function options(): ProvisionerOptions {
  return vi.mocked(ProvisionerImpl).mock.calls.at(-1)![0];
}
afterEach(() => vi.clearAllMocks());

describe('embedded provisioning wiring', () => {
  it('defers runtime access until callbacks and reads replacement bindings', async () => {
    const f = fixture();
    const result = createEmbeddedProvisioning(f.context);
    expect(result.provisioner).toBe(vi.mocked(ProvisionerImpl).mock.instances[0]);
    expect(result.deprovisioner).toBe(vi.mocked(DeprovisionerImpl).mock.instances[0]);
    const first = f.installRuntime();
    await options().beforeRunnerAdmission!(project);
    await options().onRunnerReady!(project);
    await options().onContainerStarted!(project);
    expect(first.runPendingCleanup).toHaveBeenCalledWith(project.id);
    expect(first.projectTurnReconciler).toHaveBeenCalledWith(project.id);
    expect(first.listenerDiscovery.invalidateProject).toHaveBeenCalledWith(project.id);
    expect(first.projectAgentGatewayIdentity).toHaveBeenCalledWith(true);
    expect(first.listenerDiscovery.invalidateProject.mock.invocationCallOrder[0]).toBeLessThan(
      first.projectAgentGatewayIdentity.mock.invocationCallOrder[0]!,
    );
    const second = f.installRuntime();
    await options().onContainerStarted!(project);
    await options().beforeRunnerAdmission!(project);
    await options().onRunnerReady!(project);
    expect(second.runPendingCleanup).toHaveBeenCalledWith(project.id);
    expect(second.projectTurnReconciler).toHaveBeenCalledWith(project.id);
    expect(second.projectAgentGatewayIdentity).toHaveBeenCalledWith(true);
    expect(first.projectAgentGatewayIdentity).toHaveBeenCalledTimes(1);
  });

  it('propagates cleanup and identity failures to lifecycle admission', async () => {
    const f = fixture();
    createEmbeddedProvisioning(f.context);
    const runtime = f.installRuntime();
    const failure = new Error('identity unavailable');
    runtime.projectAgentGatewayIdentity.mockRejectedValue(failure);
    await expect(options().onContainerStarted!(project)).rejects.toBe(failure);
    runtime.runPendingCleanup.mockRejectedValue(failure);
    await expect(options().beforeRunnerAdmission!(project)).rejects.toBe(failure);
  });

  it('shares teardown credentials and retains preview fencing', async () => {
    const f = fixture();
    createEmbeddedProvisioning(f.context);
    const args = vi.mocked(DeprovisionerImpl).mock.calls[0]!;
    expect(options().ghTokenCapabilities).toBe(f.context.ghTokenCapabilities);
    expect(args[6]).toBe(f.context.ghTokenCapabilities);
    expect(args[12]).toBe(f.context.signingCapabilities);
    const mutation = vi.fn(async () => project);
    const beforeRetire = vi.fn(async () => undefined);
    expect(await options().withContainerReplace!(project, mutation, beforeRetire)).toBe(project);
    expect(f.context.withPreviewProjectMutation).toHaveBeenCalledWith(
      project.id,
      mutation,
      beforeRetire,
    );
    expect(await args[10]!(project, mutation)).toBe(project);
    expect(f.context.withPreviewProjectMutation).toHaveBeenLastCalledWith(project.id, mutation);
  });

  it('selects the project forge for pull requests and rejects missing providers', async () => {
    const f = fixture();
    createEmbeddedProvisioning(f.context);
    const openPullRequest = vi.fn(async () => ({ url: 'https://forge/pull/1' }));
    vi.mocked(projectForgeProvider).mockResolvedValue({ openPullRequest } as unknown as NonNullable<
      Awaited<ReturnType<typeof projectForgeProvider>>
    >);
    const target = { owner: 'owner', repo: 'repo', forgeConnectionId: 'connection' };
    const pullRequest = { title: 'Title', body: 'Body', head: 'feature', base: 'main' };
    await options().openPullRequest!(target, 'token', pullRequest);
    expect(projectForgeProvider).toHaveBeenCalledWith(f.context.eventStore, f.context.githubForge, {
      ...target,
      kind: 'forgejo',
    });
    expect(openPullRequest).toHaveBeenCalledWith(target, 'token', pullRequest);
    vi.mocked(projectForgeProvider).mockResolvedValue(undefined);
    await expect(options().openPullRequest!(target, 'token', pullRequest)).rejects.toThrow(
      'Forge provider unavailable',
    );
  });
});
