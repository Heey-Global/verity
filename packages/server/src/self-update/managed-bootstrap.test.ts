import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readManagedDeployment } from './managed-deployment.js';
import { runManagedBootstrap, type ManagedBootstrapEnvironment } from './managed-bootstrap.js';

const digest = `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`;
const environment = async (): Promise<ManagedBootstrapEnvironment> => ({
  VERITY_MANAGED_ROOT: join(
    await mkdtemp(join(tmpdir(), 'verity-managed-bootstrap-')),
    'managed-deployment',
  ),
  VERITY_SERVER_IMAGE: digest,
  VERITY_MANAGED_DEPLOYMENT_ID: 'managed-1',
  VERITY_SERVER_UID: '1000',
  VERITY_SERVER_GID: '1000',
  VERITY_DOCKER_SOCKET_GID: '999',
  VERITY_PROJECT_RELAY_GID: '65532',
  VERITY_RUNNER_RUNTIME_GID: '1101',
  VERITY_HOST_ARCHITECTURE: 'amd64',
  HOST: '0.0.0.0',
  DATABASE_URL: 'postgres://verity@postgres:5432/verity',
  VERITY_DOCKER_BASE_URL: 'unix:///var/run/docker.sock',
  VERITY_DOCKER_SOCKET_PATH: '/var/run/docker.sock',
  VERITY_ROOT: '/srv/verity',
  VERITY_DATA_VOLUME: 'verity-data',
  VERITY_REPO_DIR: '',
});

describe('runManagedBootstrap', () => {
  it('writes the allowlisted deployment authority for an official digest', async () => {
    const env = await environment();
    await runManagedBootstrap(env, 'x64', env.VERITY_MANAGED_ROOT);
    const state = await readManagedDeployment(env.VERITY_MANAGED_ROOT!);
    expect(state).toMatchObject({
      managed: true,
      spec: {
        image: digest,
        platform: { architecture: 'amd64' },
        // The host guardrails Compose gives the `verity` service, now stated by
        // the authority that owns the container instead.
        resources: {
          memoryBytes: 4 * 1024 ** 3,
          memorySwapBytes: 4 * 1024 ** 3,
          nanoCpus: 4_000_000_000,
          pidsLimit: 512,
        },
      },
    });
  });

  it('seals the Updater control mount so the Server can reach the control socket', async () => {
    const env = await environment();
    await runManagedBootstrap(env, 'x64', env.VERITY_MANAGED_ROOT);
    const state = await readManagedDeployment(env.VERITY_MANAGED_ROOT!);
    expect(state.managed && state.spec.mounts).toContainEqual({
      source: { kind: 'volume', name: 'verity-updater-control' },
      target: '/run/verity-updater/control',
      readOnly: false,
    });
  });

  it('seals the ACP control-plane Runner volumes into a supervised Server', async () => {
    const env = {
      ...(await environment()),
      VERITY_RUNNER_SUPERVISOR: '1',
      VERITY_CONTROL_PLANE_RUNNER: '1',
      VERITY_CONTROL_PLANE_RUNNER_IDENTITY_DIR: '/run/verity-control-identity',
    };
    await runManagedBootstrap(env, 'x64', env.VERITY_MANAGED_ROOT);
    const state = await readManagedDeployment(env.VERITY_MANAGED_ROOT!);
    expect(state.managed && state.spec.mounts).toEqual(
      expect.arrayContaining([
        {
          source: { kind: 'volume', name: 'verity-control-runner-runtime' },
          target: '/srv/verity/runners/verity-control',
          readOnly: false,
        },
        {
          source: { kind: 'volume', name: 'verity-control-runner-identity' },
          target: '/run/verity-control-identity',
          readOnly: false,
        },
      ]),
    );
    expect(state.managed && state.spec.environment).toEqual(
      expect.arrayContaining([
        {
          name: 'VERITY_CONTROL_PLANE_RUNNER',
          source: { kind: 'env', name: 'VERITY_CONTROL_PLANE_RUNNER' },
        },
        {
          name: 'VERITY_CONTROL_PLANE_RUNNER_IDENTITY_DIR',
          source: { kind: 'env', name: 'VERITY_CONTROL_PLANE_RUNNER_IDENTITY_DIR' },
        },
      ]),
    );
  });

  it('does not seal the image-baked relay reference into the deployment environment', async () => {
    // It comes from the Server image, and the Updater — whose environment every
    // sealed source is resolved against — replaces itself during an update. Sealing
    // it would pin each Server to whatever relay the Updater's image happens to
    // carry, which after the next release is a different one, permanently.
    const env = {
      ...(await environment()),
      VERITY_BUNDLED_PROJECT_RELAY_IMAGE: `ghcr.io/heey-global/verity/verity-project-relay@sha256:${'c'.repeat(64)}`,
    };
    await runManagedBootstrap(env, 'x64', env.VERITY_MANAGED_ROOT);
    const state = await readManagedDeployment(env.VERITY_MANAGED_ROOT!);

    expect(state.managed).toBe(true);
    const names = state.managed ? state.spec.environment.map((entry) => entry.name) : [];
    expect(names).not.toContain('VERITY_BUNDLED_PROJECT_RELAY_IMAGE');
    // The forwarding itself still works — this is an exclusion, not a regression.
    expect(names).toContain('VERITY_DATA_VOLUME');
  });

  it('rejects an image that differs from the sealed deployment authority', async () => {
    const env = await environment();
    await runManagedBootstrap(env, 'x64', env.VERITY_MANAGED_ROOT);
    await expect(
      runManagedBootstrap(
        {
          ...env,
          VERITY_SERVER_IMAGE: `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`,
        },
        'x64',
        env.VERITY_MANAGED_ROOT,
      ),
    ).rejects.toThrow(/does not match the sealed managed deployment image/);
  });

  it.each([
    ['mutable image', { VERITY_SERVER_IMAGE: 'ghcr.io/heey-global/verity/verity-server:latest' }],
    ['custom image', { VERITY_SERVER_IMAGE: `example.com/server@sha256:${'a'.repeat(64)}` }],
    ['relative root', { VERITY_MANAGED_ROOT: 'relative' }],
    ['filesystem root', { VERITY_MANAGED_ROOT: '/' }],
    ['non-normalized root', { VERITY_MANAGED_ROOT: '/tmp/../etc/managed-deployment' }],
    ['unscoped root', { VERITY_MANAGED_ROOT: '/tmp/updater-state' }],
    ['invalid uid', { VERITY_SERVER_UID: '-1' }],
    ['whitespace uid', { VERITY_SERVER_UID: ' ' }],
    ['exponent uid', { VERITY_SERVER_UID: '1e3' }],
    ['hex uid', { VERITY_SERVER_UID: '0x3e8' }],
    ['oversized uid', { VERITY_SERVER_UID: '4294967295' }],
    ['different data volume', { VERITY_DATA_VOLUME: 'other-data' }],
    ['different data root', { VERITY_ROOT: '/other' }],
    ['different Docker endpoint', { VERITY_DOCKER_BASE_URL: 'tcp://docker:2375' }],
  ])('refuses %s', async (_label, override) => {
    const env = await environment();
    await expect(
      runManagedBootstrap({ ...env, ...override }, 'x64', env.VERITY_MANAGED_ROOT),
    ).rejects.toThrow();
  });

  it('refuses unknown host architectures', async () => {
    const env = await environment();
    await expect(runManagedBootstrap(env, 'riscv64', env.VERITY_MANAGED_ROOT)).rejects.toThrow(
      /architecture/,
    );
  });

  it('requires the deployment ID supplied to the managed container', async () => {
    const env = await environment();
    delete (env as { VERITY_MANAGED_DEPLOYMENT_ID?: string }).VERITY_MANAGED_DEPLOYMENT_ID;
    await expect(runManagedBootstrap(env, 'x64', env.VERITY_MANAGED_ROOT)).rejects.toThrow(
      /DEPLOYMENT_ID is required/,
    );
  });
});
