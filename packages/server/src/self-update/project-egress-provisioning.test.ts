import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initializeManagedDeployment,
  writeManagedUpdateChannel,
  MANAGED_DEPLOYMENT_ROOT,
  MANAGED_STAGING_ASSESSMENT_FILE,
  PROJECT_EGRESS_MOUNTS,
} from './managed-deployment.js';
import { beforeEach, expect, it, vi } from 'vitest';
import { sealDeploymentSpec, type ServerDeploymentSpec } from './deployment-spec.js';
import {
  provisionProjectEgressHost,
  reconcileInstalledProjectEgressHost,
  PROJECT_EGRESS_PROVISION_LABEL,
} from './project-egress-provisioning.js';
import { runHostRenewalJob } from './host-runtime-renewal.js';
import type { DockerClient } from '../docker.js';
import type { UpdateJournal } from './update-journal.js';

vi.mock('./host-runtime-renewal.js', () => ({
  runHostRenewalJob: vi.fn().mockResolvedValue('job'),
}));
const previous = `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`;
const target = `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`;
const journal = {
  deploymentId: 'test',
  updateId: 'update',
  previousDigest: previous,
  targetDigest: target,
} as UpdateJournal;
function spec(): ServerDeploymentSpec {
  return sealDeploymentSpec({
    schemaVersion: 2,
    deploymentId: 'test',
    image: previous,
    environment: [{ name: 'DATABASE_URL', source: { kind: 'env', name: 'DATABASE_URL' } }],
    mounts: [
      { source: { kind: 'volume', name: 'verity-data' }, target: '/srv/verity', readOnly: false },
      {
        source: { kind: 'volume', name: 'verity-agent-gateway-control' },
        target: '/run/verity-agent-gateway',
        readOnly: false,
      },
      {
        source: { kind: 'bind', path: '/var/run/docker.sock' },
        target: '/var/run/docker.sock',
        readOnly: false,
      },
      {
        source: { kind: 'bind', path: '/etc/verity' },
        target: '/run/verity-pairing',
        readOnly: true,
      },
    ],
    user: { uid: 1000, gid: 1000, supplementaryGids: [] },
    restart: 'unless-stopped',
    network: 'verity-net',
    platform: { os: 'linux', architecture: 'amd64' },
    security: { noNewPrivileges: true, readOnlyRootFilesystem: false, capAdd: [] },
  });
}
function docker(compatible = true) {
  return {
    inspectImageLabels: vi.fn(async (image: string): Promise<Record<string, string>> =>
      image === target
        ? { [PROJECT_EGRESS_PROVISION_LABEL]: '1' }
        : compatible
          ? { 'org.verity.project-egress-deployment': '1' }
          : {},
    ),
    inspectImageEnv: vi.fn(async () => [
      `VERITY_BUNDLED_PROJECT_RELAY_IMAGE=sha256:${'c'.repeat(64)}`,
    ]),
    listContainers: vi.fn(async () => [
      { id: 'postgres', labels: { 'com.docker.compose.service': 'postgres' } },
    ]),
    inspectContainer: vi.fn(
      async (): Promise<{
        running: boolean;
        networks: Record<string, object>;
        image: string;
        user?: string;
        mounts?: {
          type: string;
          name: string;
          source: string;
          destination: string;
          readWrite: boolean;
        }[];
      }> => ({
        running: true,
        networks: { 'verity-net': {} },
        image: 'postgres:18',
      }),
    ),
    removeContainer: vi.fn(async () => undefined),
  };
}
beforeEach(() => vi.clearAllMocks());
it('stages the compatibility parser before adding mounts older recovery cannot parse', async () => {
  const onSkip = vi.fn();
  expect(
    await provisionProjectEgressHost({
      docker: docker(false) as unknown as DockerClient,
      onSkip,
      journal,
      spec: spec(),
      environment: {},
    }),
  ).toBe(false);
  expect(onSkip).toHaveBeenCalledWith('installed_contract_missing');
  expect(runHostRenewalJob).not.toHaveBeenCalled();
});
it('independently verifies the release before authorizing the bounded host oneshot payload', async () => {
  const daemon = docker();
  expect(
    await provisionProjectEgressHost({
      docker: daemon as unknown as DockerClient,
      journal,
      spec: spec(),
      environment: { DATABASE_URL: 'postgres://verity:private@postgres/verity' },
    }),
  ).toBe(true);
  const jobs = vi.mocked(runHostRenewalJob).mock.calls.map((call) => call[1]);
  expect(jobs).toHaveLength(2);
  expect(jobs[0]).toMatchObject({ image: previous, network: 'bridge', binds: [] });
  expect(jobs[0]?.command).toContain(target);
  expect(jobs[1]).toMatchObject({
    image: target,
    network: 'verity-net',
    pidMode: 'host',
    readOnlyRootfs: true,
    capDrop: ['ALL'],
    capAdd: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'],
  });
  expect(jobs[1]?.binds).not.toContain('/:/host');
  expect(jobs[1]?.binds).toContain('/run/systemd:/run/systemd');
  expect(jobs[1]?.binds?.some((bind) => bind.includes('/run/dbus'))).toBe(false);
  expect(jobs[1]?.binds).toContain('/opt/verity-egress-recovery:/opt/verity-egress-recovery');
  expect(jobs[1]?.entrypoint).toEqual(['timeout', '--kill-after=5s', '750s', 'bash']);
  expect(jobs[1]?.command).toEqual(['/opt/verity-install/deploy/host/verity-egress-provision']);
  expect(jobs[1]?.env).toContain('VERITY_EGRESS_DEPLOYMENT_NETWORK=verity-net');
});
it('removes successful verification before downstream preparation can fail', async () => {
  const daemon = docker();
  daemon.listContainers.mockResolvedValue([]);
  await expect(
    provisionProjectEgressHost({
      docker: daemon as unknown as DockerClient,
      journal,
      spec: spec(),
      environment: { DATABASE_URL: 'postgres://verity:private@postgres/verity' },
    }),
  ).rejects.toThrow('requires one control-plane database');
  expect(runHostRenewalJob).toHaveBeenCalledOnce();
  expect(daemon.removeContainer).toHaveBeenCalledWith('job');
});

it('refuses a protected deployment whose predecessor cannot recover its authority', async () => {
  const initial = spec();
  const protectedSpec = {
    ...initial,
    mounts: [
      ...initial.mounts,
      {
        source: { kind: 'bind' as const, path: '/run/verity-egress' },
        target: '/run/verity-egress',
        readOnly: true,
      },
    ],
  };
  await expect(
    provisionProjectEgressHost({
      docker: docker(false) as unknown as DockerClient,
      journal,
      spec: protectedSpec,
      environment: {},
    }),
  ).rejects.toThrow('cannot recover');
  expect(runHostRenewalJob).not.toHaveBeenCalled();
});

it('rejects an incompatible target before changing already protected host authority', async () => {
  const daemon = docker();
  daemon.inspectImageLabels.mockResolvedValue({});
  const initial = spec();
  const protectedSpec = {
    ...initial,
    mounts: [
      ...initial.mounts,
      {
        source: { kind: 'bind' as const, path: '/run/verity-egress' },
        target: '/run/verity-egress',
        readOnly: true,
      },
    ],
  };
  await expect(
    provisionProjectEgressHost({
      docker: daemon as unknown as DockerClient,
      journal,
      spec: protectedSpec,
      environment: {},
    }),
  ).rejects.toThrow('Target image cannot preserve');
  expect(runHostRenewalJob).not.toHaveBeenCalled();
});

it('does not run host writes when independent target verification fails', async () => {
  vi.mocked(runHostRenewalJob).mockRejectedValueOnce(new Error('unverified target'));
  await expect(
    provisionProjectEgressHost({
      docker: docker() as unknown as DockerClient,
      journal,
      spec: spec(),
      environment: {},
    }),
  ).rejects.toThrow('unverified target');
  expect(runHostRenewalJob).toHaveBeenCalledTimes(1);
  expect(vi.mocked(runHostRenewalJob).mock.calls[0]?.[1].labels?.['verity.renewal-stage']).toBe(
    'verify',
  );
});

async function stagingFixture(protectedMounts = false) {
  const directory = await mkdtemp(join(tmpdir(), 'verity-staging-grant-'));
  const initial = spec();
  const body: Omit<ServerDeploymentSpec, 'checksum'> & { checksum?: string } = { ...initial };
  delete body.checksum;
  await initializeManagedDeployment({
    root: directory,
    deploymentId: initial.deploymentId,
    spec: {
      ...body,
      mounts: [...initial.mounts, ...(protectedMounts ? PROJECT_EGRESS_MOUNTS : [])],
    },
  });
  await writeManagedUpdateChannel(directory, 'staging');
  const daemon = docker();
  const originalInspect = daemon.inspectContainer;
  const updater = {
    running: true,
    user: '0:0',
    image: previous,
    mounts: [
      {
        type: 'volume',
        name: 'verity-managed-deployment',
        source: '/var/lib/docker/volumes/verity-managed-deployment/_data',
        destination: MANAGED_DEPLOYMENT_ROOT,
        readWrite: true,
      },
    ],
    networks: { 'verity-net': {} },
  };
  daemon.listContainers.mockResolvedValue([
    { id: 'updater', labels: { 'com.docker.compose.service': 'verity-updater' } },
    { id: 'postgres', labels: { 'com.docker.compose.service': 'postgres' } },
  ]);
  daemon.inspectContainer = vi.fn(async (...args: unknown[]) =>
    args[0] === 'updater' ? updater : originalInspect(),
  );
  return { directory, daemon, updater };
}

it('grants staging from the private updater volume and persists the channel fence before installation', async () => {
  const { directory, daemon } = await stagingFixture();
  try {
    await provisionProjectEgressHost({
      docker: daemon as unknown as DockerClient,
      journal,
      spec: spec(),
      managedRoot: directory,
      environment: { DATABASE_URL: 'postgres://verity:private@postgres/verity' },
    });
    const installation = vi.mocked(runHostRenewalJob).mock.calls[1]?.[1];
    expect(installation?.volumeMounts).toEqual([
      {
        volume: 'verity-managed-deployment',
        target: '/run/verity-egress-updater-state',
        readOnly: true,
      },
    ]);
    expect(installation?.env).toContain('VERITY_EGRESS_ASSESSMENT_CHANNEL_OWNER_UID=0');
    expect(installation?.env).toContain(
      'VERITY_EGRESS_ASSESSMENT_CHANNEL_PATH=/var/lib/docker/volumes/verity-managed-deployment/_data/update-channel.json',
    );
    expect(
      JSON.parse(await readFile(join(directory, MANAGED_STAGING_ASSESSMENT_FILE), 'utf8')),
    ).toMatchObject({ image: previous });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects a staging grant from a different installed updater image', async () => {
  const { directory, daemon, updater } = await stagingFixture();
  updater.image = target;
  try {
    await expect(
      provisionProjectEgressHost({
        docker: daemon as unknown as DockerClient,
        journal,
        spec: spec(),
        managedRoot: directory,
        environment: { DATABASE_URL: 'postgres://verity:private@postgres/verity' },
      }),
    ).rejects.toThrow(/identity changed/);
    expect(runHostRenewalJob).toHaveBeenCalledTimes(1);
    await expect(readFile(join(directory, MANAGED_STAGING_ASSESSMENT_FILE))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps mountless installed deployments explicitly pending without fabricating an update', async () => {
  const { directory, daemon } = await stagingFixture();
  daemon.inspectImageLabels.mockResolvedValue({
    [PROJECT_EGRESS_PROVISION_LABEL]: '1',
    'org.verity.project-egress-deployment': '1',
  });
  try {
    expect(
      await reconcileInstalledProjectEgressHost({
        docker: daemon as unknown as DockerClient,
        managedRoot: directory,
      }),
    ).toBe('mounts-pending');
    expect(runHostRenewalJob).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('reconciles installed staging once per image using its own signature authority', async () => {
  const { directory, daemon } = await stagingFixture(true);
  daemon.inspectImageLabels.mockResolvedValue({
    [PROJECT_EGRESS_PROVISION_LABEL]: '1',
    'org.verity.project-egress-deployment': '1',
  });
  try {
    await writeFile(
      join(directory, 'project-egress-staging-assessment.json'),
      JSON.stringify({
        version: 1,
        image: previous,
        operationId: 'a'.repeat(24),
        completed: true,
      }),
    );
    expect(
      await reconcileInstalledProjectEgressHost({
        docker: daemon as unknown as DockerClient,
        managedRoot: directory,
        environment: { DATABASE_URL: 'postgres://verity:private@postgres/verity' },
      }),
    ).toBe('attempted');
    const jobs = vi.mocked(runHostRenewalJob).mock.calls.map((call) => call[1]);
    expect(jobs[0]?.image).toBe(previous);
    expect(jobs[0]?.command).toContain(previous);
    expect(jobs[1]?.image).toBe(previous);
    expect(
      await reconcileInstalledProjectEgressHost({
        docker: daemon as unknown as DockerClient,
        managedRoot: directory,
      }),
    ).toBe('already-attempted');
    expect(runHostRenewalJob).toHaveBeenCalledTimes(2);
    await expect(readFile(join(directory, 'update-journal.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(['image', 'user', 'volume', 'writable', 'source'])(
  'rejects staging updater %s authority drift before installing',
  async (drift) => {
    const { directory, daemon, updater } = await stagingFixture();
    if (drift === 'image') updater.image = target;
    if (drift === 'user') updater.user = '1000:1000';
    if (drift === 'volume') updater.mounts[0]!.name = 'other-volume';
    if (drift === 'writable') updater.mounts[0]!.readWrite = false;
    if (drift === 'source') updater.mounts[0]!.source = '/host/../untrusted';
    try {
      await expect(
        provisionProjectEgressHost({
          docker: daemon as unknown as DockerClient,
          journal,
          spec: spec(),
          managedRoot: directory,
          environment: { DATABASE_URL: 'postgres://verity:private@postgres/verity' },
        }),
      ).rejects.toThrow(/Staging assessment/);
      expect(runHostRenewalJob).toHaveBeenCalledTimes(1);
      await expect(
        readFile(join(directory, MANAGED_STAGING_ASSESSMENT_FILE)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it('never grants assessment authority when independent signature verification fails', async () => {
  const { directory, daemon } = await stagingFixture();
  vi.mocked(runHostRenewalJob).mockRejectedValueOnce(new Error('signature invalid'));
  try {
    await expect(
      provisionProjectEgressHost({
        docker: daemon as unknown as DockerClient,
        journal,
        spec: spec(),
        managedRoot: directory,
        environment: {},
      }),
    ).rejects.toThrow(/signature invalid/);
    expect(runHostRenewalJob).toHaveBeenCalledTimes(1);
    await expect(readFile(join(directory, MANAGED_STAGING_ASSESSMENT_FILE))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('resumes installed staging after an installation wait disconnect instead of treating its grant as completion', async () => {
  const { directory, daemon } = await stagingFixture(true);
  daemon.inspectImageLabels.mockResolvedValue({
    [PROJECT_EGRESS_PROVISION_LABEL]: '1',
    'org.verity.project-egress-deployment': '1',
  });
  const options = {
    docker: daemon as unknown as DockerClient,
    managedRoot: directory,
    environment: { DATABASE_URL: 'postgres://verity:private@postgres/verity' },
  };
  try {
    vi.mocked(runHostRenewalJob)
      .mockResolvedValueOnce('verified')
      .mockRejectedValueOnce(new Error('wait disconnected'));
    await expect(reconcileInstalledProjectEgressHost(options)).rejects.toThrow('wait disconnected');
    const marker = JSON.parse(
      await readFile(join(directory, MANAGED_STAGING_ASSESSMENT_FILE), 'utf8'),
    ) as { completed: boolean };
    expect(marker.completed).toBe(false);
    await expect(writeManagedUpdateChannel(directory, 'stable')).rejects.toThrow('deactivation');
    expect(await reconcileInstalledProjectEgressHost(options)).toBe('attempted');
    const jobs = vi.mocked(runHostRenewalJob).mock.calls.map((call) => call[1]);
    expect(jobs[3]?.name).toBe(jobs[1]?.name);
    expect(await reconcileInstalledProjectEgressHost(options)).toBe('already-attempted');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
