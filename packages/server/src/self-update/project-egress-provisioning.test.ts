import { beforeEach, expect, it, vi } from 'vitest';
import { sealDeploymentSpec, type ServerDeploymentSpec } from './deployment-spec.js';
import {
  provisionProjectEgressHost,
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
    inspectImageLabels: vi.fn(async (image: string) =>
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
    inspectContainer: vi.fn(async () => ({
      running: true,
      networks: { 'verity-net': {} },
      image: 'postgres:18',
    })),
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
  expect(jobs[1]?.binds).toContain('/opt/verity-egress-recovery:/opt/verity-egress-recovery');
  expect(jobs[1]?.entrypoint).toEqual(['timeout', '--kill-after=5s', '750s', 'bash']);
  expect(jobs[1]?.command).toEqual(['/opt/verity-install/deploy/host/verity-egress-provision']);
  expect(jobs[1]?.env).toContain('VERITY_EGRESS_DEPLOYMENT_NETWORK=verity-net');
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
