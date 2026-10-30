import { describe, expect, it, vi } from 'vitest';
import type { ContainerSpec } from '../docker.js';
import { sealDeploymentSpec } from './deployment-spec.js';
import { backupProvisionPlan, provisionBackupHost } from './backup-provisioning.js';
const image = `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`;
const spec = sealDeploymentSpec({
  schemaVersion: 2,
  deploymentId: 'backup-test',
  image,
  environment: [],
  mounts: [
    { source: { kind: 'volume', name: 'verity-data' }, target: '/srv/verity', readOnly: false },
    {
      source: { kind: 'volume', name: 'verity-agent-gateway-control' },
      target: '/run/verity-agent-gateway',
      readOnly: false,
    },
    {
      source: { kind: 'bind', path: '/etc/verity' },
      target: '/run/verity-pairing',
      readOnly: true,
    },
    {
      source: { kind: 'bind', path: '/var/run/docker.sock' },
      target: '/var/run/docker.sock',
      readOnly: false,
    },
  ],
  user: { uid: 1000, gid: 1000, supplementaryGids: [] },
  restart: 'unless-stopped',
  network: 'verity-net',
  platform: { os: 'linux', architecture: 'amd64' },
  security: { noNewPrivileges: true, readOnlyRootFilesystem: false, capAdd: [] },
});
const plan = {
  version: 1 as const,
  statePath: '/etc/verity',
  backupPath: '/srv/archives',
  identityPath: '/var/lib/verity/backup-identity',
  provisioned: false,
};
function docker() {
  return {
    inspectImageLabels: vi.fn().mockResolvedValue({ 'org.verity.backup-provisioning': '1' }),
    createContainer: vi
      .fn<(spec: ContainerSpec) => Promise<{ id: string; warnings: string[] }>>()
      .mockResolvedValue({ id: 'job', warnings: [] }),
    startContainer: vi.fn().mockResolvedValue(undefined),
    waitContainer: vi.fn().mockResolvedValue(0),
    containerLogs: vi.fn().mockResolvedValue(JSON.stringify(plan)),
    removeContainer: vi.fn().mockResolvedValue(undefined),
    listContainers: vi
      .fn()
      .mockResolvedValue([
        { id: 'b'.repeat(64), labels: { 'com.docker.compose.service': 'postgres' } },
      ]),
    inspectContainer: vi.fn().mockResolvedValue({
      running: true,
      networks: { 'verity-net': {} },
    }),
  };
}
describe('bounded release-owned backup provisioning', () => {
  it('skips releases predating the contract without any helper or host writes', async () => {
    const client = docker();
    client.inspectImageLabels.mockResolvedValue({});
    expect(await backupProvisionPlan(client, spec, image)).toBeUndefined();
    expect(client.createContainer).not.toHaveBeenCalled();
  });
  it('does not invent installer host authority for hand-assembled deployments', async () => {
    const client = docker();
    const manual = {
      ...spec,
      mounts: spec.mounts.filter((mount) => mount.target !== '/run/verity-pairing'),
    };
    expect(await backupProvisionPlan(client, manual, image)).toBeUndefined();
    expect(client.createContainer).not.toHaveBeenCalled();
  });
  it('discovers configured paths through the sealed readonly identity bind', async () => {
    const client = docker();
    expect(await backupProvisionPlan(client, spec, image)).toEqual(plan);
    expect(client.createContainer.mock.calls[0]?.[0]).toMatchObject({
      network: 'none',
      user: '0:0',
      readOnlyRootfs: true,
      binds: ['/etc/verity:/etc/verity:ro'],
      capDrop: ['ALL'],
    });
    expect(client.removeContainer).toHaveBeenCalledWith('job');
  });
  it.each([
    { ...plan, statePath: '/etc' },
    { ...plan, backupPath: '/srv/a:ro' },
    { ...plan, identityPath: '/etc' },
  ])('refuses a helper response outside sealed authority', async (response) => {
    const client = docker();
    client.containerLogs.mockResolvedValue(JSON.stringify(response));
    await expect(backupProvisionPlan(client, spec, image)).rejects.toThrow('authority');
    expect(client.removeContainer).toHaveBeenCalledWith('job');
  });
  it('applies only fixed host actions then rereads the capability receipt', async () => {
    const client = docker();
    client.containerLogs
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(JSON.stringify({ ...plan, provisioned: true }));
    await provisionBackupHost(client, spec, image, plan);
    expect(client.createContainer.mock.calls[0]?.[0]).toMatchObject({
      network: 'none',
      entrypoint: ['timeout', '--kill-after=5s', '110s', 'bash'],
      command: ['/opt/verity-install/deploy/host/verity-backup-provision'],
      capAdd: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'],
    });
    expect(client.createContainer.mock.calls[0]?.[0].binds).toContain(
      '/srv/archives:/srv/archives',
    );
    expect(client.removeContainer).toHaveBeenCalledTimes(3);
  });
  it('fails closed if provisioning exits unsuccessfully, without leaking logs', async () => {
    const client = docker();
    client.waitContainer.mockResolvedValue(1);
    await expect(provisionBackupHost(client, spec, image, plan)).rejects.toThrow(
      'previous Server remains active',
    );
    expect(client.containerLogs).not.toHaveBeenCalled();
    expect(client.removeContainer).toHaveBeenCalledWith('job');
  });
  it('requires a unique running PostgreSQL on the sealed network', async () => {
    const client = docker();
    client.listContainers.mockResolvedValue([]);
    await expect(provisionBackupHost(client, spec, image, plan)).rejects.toThrow('unique');
    expect(client.createContainer).not.toHaveBeenCalled();
  });
  it('does not accept a successful job without a durable receipt', async () => {
    const client = docker();
    await expect(provisionBackupHost(client, spec, image, plan)).rejects.toThrow('not verified');
  });
  it('rejects unsupported contracts and nonofficial image references', async () => {
    const client = docker();
    await expect(backupProvisionPlan(client, spec, 'example.com/host:latest')).rejects.toThrow(
      'official digest',
    );
    client.inspectImageLabels.mockResolvedValue({ 'org.verity.backup-provisioning': '2' });
    await expect(backupProvisionPlan(client, spec, image)).rejects.toThrow('Unsupported');
    expect(client.createContainer).not.toHaveBeenCalled();
  });
});
