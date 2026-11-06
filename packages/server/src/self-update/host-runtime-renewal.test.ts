import { describe, expect, it, vi } from 'vitest';
import type { ContainerInspect, ContainerSpec } from '../docker.js';
import {
  runHostRenewalJob,
  renewHostRuntimeService,
  parseRuntimeServiceRequirements,
} from './host-runtime-renewal.js';
import type { UpdateJournal } from './update-journal.js';

const image = (char: string) =>
  `ghcr.io/heey-global/verity/verity-server@sha256:${char.repeat(64)}`;
const journal = {
  deploymentId: 'deployment-1',
  updateId: 'update-1',
  previousDigest: image('a'),
  targetDigest: image('b'),
} as UpdateJournal;
function fixture() {
  const jobs = new Map<string, { spec: ContainerSpec; inspect: ContainerInspect }>();
  const docker = {
    createContainer: vi.fn(async (spec: ContainerSpec) => {
      const id = String(jobs.size + 1).repeat(64);
      jobs.set(id, {
        spec,
        inspect: {
          id,
          running: false,
          status: 'created',
          image: spec.image,
          user: spec.user,
          networkMode: spec.network,
          readOnlyRootfs: spec.readOnlyRootfs,
          restartPolicy: spec.restartPolicy,
          capAdd: spec.capAdd,
          capDrop: spec.capDrop,
          groupAdd: [],
          // Docker 29 appends label=disable for host-PID jobs, including old specs.
          securityOpt: [
            ...new Set([
              ...(spec.securityOpt ?? []),
              ...(spec.pidMode === 'host' ? ['label=disable'] : []),
            ]),
          ],
          labels: spec.labels,
          entrypoint: spec.entrypoint,
          command: spec.command,
          init: true,
          env: spec.env,
          runtime: spec.runtime,
          pidMode: spec.pidMode ?? '',
          privileged: false,
          deviceCount: 0,
          tmpfs: spec.tmpfs,
          pidsLimit: spec.pidsLimit,
          memoryBytes: spec.memoryBytes,
          memorySwapBytes: spec.memorySwapBytes,
          mounts: (spec.binds ?? [])
            .map((bind) => {
              const [source, destination, mode] = bind.split(':');
              return { type: 'bind', source, destination, readWrite: mode !== 'ro' };
            })
            .concat([{ type: 'tmpfs', source: '', destination: '/tmp', readWrite: true }]),
        },
      });
      return { id, warnings: [] };
    }),
    startContainer: vi.fn(async (id: string) => {
      jobs.get(id)!.inspect.status = 'running';
      jobs.get(id)!.inspect.running = true;
    }),
    waitContainer: vi.fn(async (id: string) => {
      jobs.get(id)!.inspect.status = 'exited';
      jobs.get(id)!.inspect.running = false;
      return 0;
    }),
    listContainers: vi.fn(async () =>
      [...jobs].map(([id, job]) => ({
        id,
        imageId: job.spec.image,
        names: [job.spec.name],
        labels: job.spec.labels ?? {},
      })),
    ),
    inspectContainer: vi.fn(async (id: string) => jobs.get(id)!.inspect),
    inspectImageEnv: vi.fn(async () => []),
    containerLogs: vi.fn(async () => ''),
    removeContainer: vi.fn(async (id: string) => {
      jobs.delete(id);
    }),
  };
  const verifyInstalled = vi.fn(async () => undefined);
  const run = () =>
    renewHostRuntimeService({
      docker,
      journal,
      runtimeHostPath: '/var/lib/verity/host-runtime',
      installerStatePath: '/etc/verity',
      verifyInstalled,
    });
  return { docker, jobs, run, verifyInstalled };
}
describe('authenticated runtime service renewal', () => {
  it('verifies using installed code without mounts before granting target code fixed host writes', async () => {
    const h = fixture();
    await h.run();
    const [verify, install] = h.docker.createContainer.mock.calls.map(([spec]) => spec);
    expect(verify).toMatchObject({
      image: journal.previousDigest,
      runtime: 'runc',
      network: 'bridge',
      binds: [],
      capDrop: ['ALL'],
      readOnlyRootfs: true,
    });
    expect(verify!.command).toEqual(
      expect.arrayContaining([
        'verify',
        journal.targetDigest,
        'https://token.actions.githubusercontent.com',
        'https://github.com/Heey-Global/verity/.github/workflows/release.yml@refs/heads/main',
      ]),
    );
    expect(install).toMatchObject({
      image: journal.targetDigest,
      runtime: 'runc',
      network: 'none',
      pidMode: 'host',
      securityOpt: ['no-new-privileges=true', 'label=disable'],
      capAdd: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'],
      capDrop: ['ALL'],
      restartPolicy: 'no',
      readOnlyRootfs: true,
    });
    expect(install!.binds).toEqual([
      '/var/lib/verity/host-runtime:/var/lib/verity/host-runtime',
      '/var/lib/verity/host-runtime-private:/var/lib/verity/host-runtime-private',
      '/etc/verity/.verity-install.lock:/run/verity-install.lock',
      '/usr/local/libexec/verity:/usr/local/libexec/verity',
      '/etc/systemd/system:/etc/systemd/system',
      '/run/systemd:/run/systemd',
    ]);
    expect(install!.entrypoint).toEqual(['timeout', '--kill-after=5s', '110s', 'bash']);
    expect(h.verifyInstalled).toHaveBeenCalledOnce();
    expect(h.jobs.size).toBe(0);
  });
  it('never starts the host writer after a signature verification failure', async () => {
    const h = fixture();
    h.docker.waitContainer.mockResolvedValueOnce(1);
    await expect(h.run()).rejects.toThrow(/no host changes were made/u);
    expect(h.docker.createContainer).toHaveBeenCalledOnce();
    expect(h.verifyInstalled).not.toHaveBeenCalled();
  });
  it('reattaches to a daemon-owned helper after the updater loses its connection', async () => {
    const h = fixture();
    h.docker.waitContainer
      .mockImplementationOnce(async (id) => {
        h.jobs.get(id)!.inspect.status = 'exited';
        return 0;
      })
      .mockRejectedValueOnce(new Error('connection lost'));
    await expect(h.run()).rejects.toThrow('connection lost');
    expect(h.jobs.size).toBe(2);
    expect(h.docker.removeContainer).not.toHaveBeenCalled();
    await h.run();
    expect(h.docker.createContainer).toHaveBeenCalledTimes(2);
    expect(h.docker.startContainer).toHaveBeenCalledTimes(2);
    expect(h.jobs.size).toBe(0);
  });
  it.each([
    'image',
    'labels',
    'mounts',
    'entrypoint',
    'runtime',
    'pidMode',
    'networkMode',
    'capDrop',
    'capAdd',
    'privileged',
    'securityOpt',
    'tmpfs',
    'memoryBytes',
    'env',
  ] as const)('rejects a recovered helper with a changed %s', async (field) => {
    const h = fixture();
    h.docker.waitContainer
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error('disconnected'));
    await expect(h.run()).rejects.toThrow('disconnected');
    const install = [...h.jobs.values()].find((job) => job.spec.network === 'none')!;
    install.inspect.status = 'running';
    const replacement: unknown = {
      image: image('c'),
      labels: {},
      mounts: [],
      entrypoint: ['bash'],
      runtime: 'runsc',
      pidMode: '',
      networkMode: 'bridge',
      capDrop: [],
      capAdd: ['SYS_ADMIN'],
      privileged: true,
      securityOpt: [],
      tmpfs: {},
      memoryBytes: 1,
      env: ['HOME=/evil'],
    }[field];
    Object.assign(install.inspect, { [field]: replacement });
    await expect(h.run()).rejects.toThrow(/authorized configuration/u);
    expect(h.verifyInstalled).not.toHaveBeenCalled();
  });
  it('rejects unexpected tmpfs mounts in Docker inspection', async () => {
    const h = fixture();
    const original = h.docker.inspectContainer.getMockImplementation()!;
    h.docker.inspectContainer.mockImplementation(async (id) => {
      const inspect = await original(id);
      return {
        ...inspect,
        mounts: [
          ...(inspect.mounts ?? []),
          { type: 'tmpfs', destination: '/extra', readWrite: true },
        ],
      };
    });
    await expect(h.run()).rejects.toThrow(/authorized configuration/u);
    expect(h.docker.startContainer).not.toHaveBeenCalled();
  });
  it('relays only a digest-bound verified rollback disposition', async () => {
    const h = fixture();
    h.docker.waitContainer.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    h.docker.containerLogs.mockResolvedValue(
      JSON.stringify({
        version: 1,
        updateId: journal.updateId,
        targetDigest: journal.targetDigest,
        outcome: 'restored',
      }),
    );
    await expect(h.run()).rejects.toMatchObject({ recovery: 'restored' });
    const other = fixture();
    other.docker.waitContainer.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    other.docker.containerLogs.mockResolvedValue(
      JSON.stringify({
        version: 1,
        updateId: 'old-update',
        targetDigest: journal.targetDigest,
        outcome: 'restored',
      }),
    );
    await expect(other.run()).rejects.toMatchObject({ recovery: 'recovery-required' });
  });
  it('retains stopped helper evidence until installed receipt verification succeeds', async () => {
    const h = fixture();
    h.verifyInstalled.mockRejectedValueOnce(new Error('receipt mismatch'));
    await expect(h.run()).rejects.toThrow('receipt mismatch');
    expect(h.jobs.size).toBe(2);
    await h.run();
    expect(h.docker.createContainer).toHaveBeenCalledTimes(2);
    expect(h.jobs.size).toBe(0);
  });
  it.each(['create', 'inspect', 'verify-wait'] as const)(
    'classifies %s failures before host writes as unchanged',
    async (stage) => {
      const h = fixture();
      if (stage === 'create')
        h.docker.createContainer.mockRejectedValueOnce(new Error('create failed'));
      if (stage === 'inspect')
        h.docker.inspectContainer.mockRejectedValueOnce(new Error('inspect failed'));
      if (stage === 'verify-wait')
        h.docker.waitContainer.mockRejectedValueOnce(new Error('wait failed'));
      await expect(h.run()).rejects.toMatchObject({ recovery: 'unchanged' });
      expect(h.verifyInstalled).not.toHaveBeenCalled();
    },
  );
  it('retains an install job after an ambiguous start failure', async () => {
    const h = fixture();
    h.docker.startContainer
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('start disconnected'));
    await expect(h.run()).rejects.toMatchObject({ recovery: 'recovery-required' });
    expect(h.docker.removeContainer).not.toHaveBeenCalled();
  });
  it('replaces only an owned Created job and never accepts extra security options', async () => {
    const h = fixture();
    h.docker.startContainer
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('disconnected'));
    await expect(h.run()).rejects.toThrow('disconnected');
    const install = [...h.jobs.values()].find((job) => job.spec.pidMode === 'host')!;
    install.inspect.securityOpt = ['no-new-privileges=true', 'label=disable', 'seccomp=unconfined'];
    const old = install.inspect.id;
    await h.run();
    expect(h.docker.removeContainer).toHaveBeenCalledWith(old);
    expect(h.docker.createContainer).toHaveBeenCalledTimes(3);
  });
  it('never removes a foreign Created job', async () => {
    const h = fixture();
    h.docker.startContainer
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('disconnected'));
    await expect(h.run()).rejects.toThrow('disconnected');
    const install = [...h.jobs.values()].find((job) => job.spec.pidMode === 'host')!;
    install.inspect.labels = { ...install.inspect.labels, 'verity.update-id': 'foreign' };
    await expect(h.run()).rejects.toMatchObject({ recovery: 'unchanged' });
    expect(h.docker.removeContainer).not.toHaveBeenCalled();
  });
  it('does not report unchanged when re-verification fails after an earlier install started', async () => {
    const h = fixture();
    h.docker.waitContainer
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error('disconnected'));
    await expect(h.run()).rejects.toMatchObject({ recovery: 'recovery-required' });
    h.docker.waitContainer.mockRejectedValueOnce(new Error('verification disconnected'));
    await expect(h.run()).rejects.toMatchObject({ recovery: 'recovery-required' });
    expect(h.docker.removeContainer).not.toHaveBeenCalled();
  });
  it('retains recovery-required if inventory fails after an ambiguous install start', async () => {
    const h = fixture();
    h.docker.startContainer
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('start disconnected'));
    await expect(h.run()).rejects.toMatchObject({ recovery: 'recovery-required' });
    h.docker.listContainers.mockRejectedValueOnce(new Error('inventory unavailable'));
    await expect(h.run()).rejects.toMatchObject({ recovery: 'recovery-required' });
    expect(h.docker.removeContainer).not.toHaveBeenCalled();
  });
  it('rejects malformed service capability declarations', () => {
    expect(
      parseRuntimeServiceRequirements({ revision: 1, renewalProtocol: 1, features: ['archive'] }),
    ).not.toBeNull();
    for (const value of [
      null,
      {},
      { revision: 0, renewalProtocol: 1, features: [] },
      { revision: 1, renewalProtocol: 1, features: ['../bad'] },
      { revision: 1, renewalProtocol: 1, features: [], extra: true },
    ])
      expect(parseRuntimeServiceRequirements(value)).toBeNull();
  });
});

async function egressJobFixture(stage: 'install' | 'verify' = 'install') {
  const h = fixture();
  h.verifyInstalled.mockRejectedValueOnce(new Error('receipt mismatch'));
  await expect(h.run()).rejects.toThrow('receipt mismatch');
  const job = [...h.jobs.values()].find(
    (item) => item.spec.labels?.['verity.renewal-stage'] === stage,
  )!;
  job.spec.name = `verity-egress-${stage}-${'c'.repeat(24)}`;
  job.spec.labels = { ...job.spec.labels, 'verity.managed-role': 'egress-provisioning' };
  job.inspect.labels = job.spec.labels;
  h.docker.waitContainer.mockResolvedValue(1);
  return { ...h, spec: job.spec, runJob: () => runHostRenewalJob(h.docker, job.spec) };
}

describe('project egress helper failure diagnostics', () => {
  const diagnostic = {
    version: 1,
    kind: 'egress-provisioning',
    operationId: 'c'.repeat(24),
    phase: 'submit',
    code: 'start_unverified',
    exitCode: 1,
  };

  it('reports the failing provisioning phase without claiming runtime restoration', async () => {
    const h = await egressJobFixture();
    h.docker.containerLogs.mockResolvedValue(JSON.stringify(diagnostic));
    await expect(h.runJob()).rejects.toMatchObject({
      name: 'ProjectEgressProvisioningError',
      recovery: 'recovery-required',
      message: expect.stringContaining('phase submit, code start_unverified'),
    });
    expect(h.docker.containerLogs).toHaveBeenCalledWith(expect.any(String), 1);
  });

  it('reports an allowlisted host failure reason and step', async () => {
    const h = await egressJobFixture();
    h.docker.containerLogs.mockResolvedValue(
      JSON.stringify({
        ...diagnostic,
        phase: 'observe',
        code: 'host_failed',
        reason: 'relay_reload_failed',
        step: 'prerequisites',
      }),
    );
    await expect(h.runJob()).rejects.toMatchObject({
      recovery: 'recovery-required',
      message: expect.stringContaining(
        'phase observe, code host_failed, reason relay_reload_failed, step prerequisites',
      ),
    });
  });

  it.each([
    { reason: 'postgres://secret@private', step: 'postgres://secret@private' },
    { reason: 'unknown_failure', step: 'unknown_step' },
    { reason: { message: 'secret' }, step: ['secret'] },
    { reason: null, step: null },
  ])('omits unsupported host diagnostics while retaining safe context: %j', async (fields) => {
    const h = await egressJobFixture();
    h.docker.containerLogs.mockResolvedValue(JSON.stringify({ ...diagnostic, ...fields }));
    const error = await h.runJob().catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      message: expect.stringContaining('phase submit, code start_unverified'),
    });
    expect(error).toMatchObject({
      message: expect.not.stringMatching(/reason |step |secret|unknown_/u),
    });
  });

  it('does not accept safe host diagnostics from another operation', async () => {
    const h = await egressJobFixture();
    h.docker.containerLogs.mockResolvedValue(
      JSON.stringify({
        ...diagnostic,
        operationId: 'd'.repeat(24),
        reason: 'relay_reload_failed',
        step: 'prerequisites',
      }),
    );
    await expect(h.runJob()).rejects.toMatchObject({
      message: expect.not.stringMatching(/phase |reason |step /u),
    });
  });

  it.each([
    { ...diagnostic, operationId: 'd'.repeat(24) },
    { ...diagnostic, exitCode: 2 },
    { ...diagnostic, phase: 'postgres://secret@private' },
    { ...diagnostic, code: 'postgres://secret@private' },
    {
      version: 1,
      updateId: journal.updateId,
      targetDigest: journal.targetDigest,
      outcome: 'restored',
    },
    null,
  ])('refuses unbound or non-allowlisted helper output: %j', async (value) => {
    const h = await egressJobFixture();
    h.docker.containerLogs.mockResolvedValue(JSON.stringify(value));
    await expect(h.runJob()).rejects.toMatchObject({
      recovery: 'recovery-required',
      message: expect.not.stringMatching(/phase |secret|restored/u),
    });
  });

  it('keeps safe failure context when logs are unavailable', async () => {
    const h = await egressJobFixture();
    h.docker.containerLogs.mockRejectedValueOnce(new Error('private docker error'));
    await expect(h.runJob()).rejects.toMatchObject({
      recovery: 'recovery-required',
      message: expect.stringContaining(
        'Project network protection preparation failed (install, exit 1',
      ),
    });
  });

  it.each(['postgres://secret@private', 'x'.repeat(4097)])(
    'does not relay raw or oversized logs',
    async (logs) => {
      const h = await egressJobFixture();
      h.docker.containerLogs.mockResolvedValue(logs);
      await expect(h.runJob()).rejects.toMatchObject({
        recovery: 'recovery-required',
        message: expect.not.stringMatching(/secret|xxxx|phase /u),
      });
    },
  );

  it('ignores private fields even in an otherwise valid diagnostic', async () => {
    const h = await egressJobFixture();
    h.docker.containerLogs.mockResolvedValue(
      JSON.stringify({ ...diagnostic, error: 'postgres://secret@private' }),
    );
    const error = await h.runJob().catch((failure: unknown) => failure);
    expect(error).toMatchObject({ message: expect.stringContaining('code start_unverified') });
    expect(error).toMatchObject({ message: expect.not.stringContaining('secret') });
  });

  it('distinguishes signature verification from host installation', async () => {
    const h = await egressJobFixture('verify');
    await expect(h.runJob()).rejects.toMatchObject({
      recovery: 'unchanged',
      message: expect.stringContaining('Target verification did not complete'),
    });
  });
});

it('waits beyond the owned installer timeout when adopting a long-running job', async () => {
  const h = fixture();
  await h.run();
  const spec = h.docker.createContainer.mock.calls.find(
    ([value]) => value.labels?.['verity.renewal-stage'] === 'install',
  )![0];
  const entrypoint = ['timeout', '--kill-after=5s', '750s', 'bash'];
  await runHostRenewalJob(h.docker, { ...spec, name: 'long-install', entrypoint });
  expect(h.docker.waitContainer).toHaveBeenLastCalledWith(expect.any(String), {
    timeoutMs: Number.parseInt(entrypoint[2]!, 10) * 1000 + 30_000,
  });
});
