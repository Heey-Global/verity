import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readManagedDeployment,
  MANAGED_DEPLOYMENT_SPEC_FILE,
  MANAGED_HOST_DIAGNOSTIC_BACKUP_FILE,
} from './managed-deployment.js';
import { sealDeploymentSpec } from './deployment-spec.js';
import { managedServerContainerSpec } from './managed-server-owner.js';
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
  VERITY_PAIRING_STATE_HOST_PATH: '/etc/verity',
});

describe('runManagedBootstrap', () => {
  it('delivers the read-only Compose diagnostic bind to the managed Server', async () => {
    const compose = parseYaml(readFileSync('deploy/docker-compose.yml', 'utf8'), {
      merge: true,
    }) as {
      services: Record<string, { volumes?: unknown[]; environment: Record<string, string> }>;
    };
    const composeMount = compose.services.verity!.volumes!.find(
      (mount): mount is string =>
        typeof mount === 'string' && mount.includes(':/run/verity-host-diagnostics:'),
    )!;
    const env = await environment();
    await runManagedBootstrap(env, 'x64', env.VERITY_MANAGED_ROOT);
    const state = await readManagedDeployment(env.VERITY_MANAGED_ROOT!);
    if (!state.managed) throw new Error(state.reason);
    const desired = await managedServerContainerSpec(state.spec, env, async () => '');
    const resolvedMount = composeMount.replace(/\$\{[^:}]+:-([^}]+)\}/gu, '$1');
    expect(desired.binds).toContain(resolvedMount);
    expect(compose.services['managed-bootstrap']!.environment.VERITY_HOST_DIAGNOSTIC_DIR).toBe(
      composeMount.split('}')[0] + '}',
    );
    expect(
      state.spec.environment.some((entry) => entry.name === 'VERITY_HOST_DIAGNOSTIC_DIR'),
    ).toBe(false);
  });

  it('migrates a legacy sealed deployment on an installer rerun without inventing other authority', async () => {
    const env = { ...(await environment()), VERITY_RUNNER_SUPERVISOR: '1' };
    await runManagedBootstrap(env, 'x64', env.VERITY_MANAGED_ROOT);
    const current = await readManagedDeployment(env.VERITY_MANAGED_ROOT!);
    if (!current.managed) throw new Error(current.reason);
    const { checksum, resources, ...legacyBody } = current.spec;
    expect(checksum).toBeDefined();
    expect(resources).toBeDefined();
    const legacy = sealDeploymentSpec({
      ...legacyBody,
      mounts: legacyBody.mounts.filter((mount) => mount.target !== '/run/verity-host-diagnostics'),
    });
    await writeFile(
      join(env.VERITY_MANAGED_ROOT!, MANAGED_DEPLOYMENT_SPEC_FILE),
      JSON.stringify(legacy),
    );
    expect((await readManagedDeployment(env.VERITY_MANAGED_ROOT!)).managed).toBe(true);
    await runManagedBootstrap(env, 'x64', env.VERITY_MANAGED_ROOT);
    const migrated = await readManagedDeployment(env.VERITY_MANAGED_ROOT!);
    if (!migrated.managed) throw new Error(migrated.reason);
    expect(migrated.spec.mounts).toHaveLength(legacy.mounts.length + 1);
    const backupPath = join(env.VERITY_MANAGED_ROOT!, MANAGED_HOST_DIAGNOSTIC_BACKUP_FILE);
    expect(JSON.parse(await readFile(backupPath, 'utf8'))).toEqual(legacy);
    expect(migrated.spec.mounts).toEqual(expect.arrayContaining([...legacy.mounts]));
    expect(migrated.spec.environment).toEqual(legacy.environment);
    expect(migrated.spec.image).toBe(legacy.image);
    expect(migrated.spec.user).toEqual(legacy.user);
    expect(migrated.spec.security).toEqual(legacy.security);
    expect(migrated.spec).not.toHaveProperty('resources');
    const desired = await managedServerContainerSpec(migrated.spec, env, async () => '');
    expect(desired.binds).toContain(
      '/var/lib/verity/host-diagnostics:/run/verity-host-diagnostics:ro',
    );
    await runManagedBootstrap(env, 'x64', env.VERITY_MANAGED_ROOT);
    expect(await readManagedDeployment(env.VERITY_MANAGED_ROOT!)).toEqual(migrated);
    expect(JSON.parse(await readFile(backupPath, 'utf8'))).toEqual(legacy);
    await expect(
      runManagedBootstrap(
        { ...env, VERITY_HOST_DIAGNOSTIC_DIR: '/another/host-diagnostics' },
        'x64',
        env.VERITY_MANAGED_ROOT,
      ),
    ).rejects.toThrow('sealed authority');
    expect(await readManagedDeployment(env.VERITY_MANAGED_ROOT!)).toEqual(migrated);
  });

  it('forwards explicit Staging OAuth overrides without pinning the baked image default', async () => {
    const compose = parseYaml(
      readFileSync(
        process.env.VERITY_TEST_COMPOSE_FILE ??
          new URL('../../../../deploy/docker-compose.yml', import.meta.url),
        'utf8',
      ),
      { merge: true },
    ) as { services: Record<string, { environment: Record<string, string> }> };
    // A host .env value otherwise disappears before the bootstrap ever sees it.
    expect(compose.services['verity-updater']!.environment.STAGING_GOOGLE_AUTH_ID).toBe(
      '${STAGING_GOOGLE_AUTH_ID:-}',
    );
    const env = {
      ...(await environment()),
      STAGING_GOOGLE_AUTH_ID: 'override',
      GOOGLE_STAGING_CLIENT_ID_DEFAULT: 'baked',
    };
    await runManagedBootstrap(env, 'x64', env.VERITY_MANAGED_ROOT);
    const state = await readManagedDeployment(env.VERITY_MANAGED_ROOT!);
    expect(state.managed).toBe(true);
    if (!state.managed) throw new Error('bootstrap did not establish managed authority');
    expect(state.spec.environment).toContainEqual({
      name: 'STAGING_GOOGLE_AUTH_ID',
      source: { kind: 'env', name: 'STAGING_GOOGLE_AUTH_ID' },
    });
    // Pinning an empty baked default would disable Staging OAuth after later image updates.
    expect(
      state.spec.environment.some((entry) => entry.name === 'GOOGLE_STAGING_CLIENT_ID_DEFAULT'),
    ).toBe(false);
  });

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

  it('seals the read-only pairing material mount', async () => {
    const env = await environment();
    await runManagedBootstrap(env, 'x64', env.VERITY_MANAGED_ROOT);
    const state = await readManagedDeployment(env.VERITY_MANAGED_ROOT!);
    expect(state.managed && state.spec.mounts).toContainEqual({
      source: { kind: 'bind', path: '/etc/verity' },
      target: '/run/verity-pairing',
      readOnly: true,
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
      VERITY_BUNDLED_MATRIX_CONNECTOR_IMAGE: `ghcr.io/heey-global/verity/verity-matrix-connector@sha256:${'d'.repeat(64)}`,
    };
    await runManagedBootstrap(env, 'x64', env.VERITY_MANAGED_ROOT);
    const state = await readManagedDeployment(env.VERITY_MANAGED_ROOT!);

    expect(state.managed).toBe(true);
    const names = state.managed ? state.spec.environment.map((entry) => entry.name) : [];
    expect(names).not.toContain('VERITY_BUNDLED_PROJECT_RELAY_IMAGE');
    expect(names).not.toContain('VERITY_BUNDLED_MATRIX_CONNECTOR_IMAGE');
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

  it('advances only the explicitly named sealed image for an unpaired reinstall', async () => {
    const env = await environment();
    await runManagedBootstrap(env, 'x64', env.VERITY_MANAGED_ROOT);
    const next = `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`;

    await runManagedBootstrap(
      {
        ...env,
        VERITY_SERVER_IMAGE: next,
        VERITY_BOOTSTRAP_ADVANCE_IMAGE_FROM: digest,
      },
      'x64',
      env.VERITY_MANAGED_ROOT,
      async (action) => action(),
    );

    const state = await readManagedDeployment(env.VERITY_MANAGED_ROOT!);
    expect(state.managed && state.spec.image).toBe(next);
  });

  it('resumes an unpaired reinstall from the currently sealed image', async () => {
    const env = await environment();
    await runManagedBootstrap(env, 'x64', env.VERITY_MANAGED_ROOT);
    const intermediate = `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`;
    const latest = `ghcr.io/heey-global/verity/verity-server@sha256:${'c'.repeat(64)}`;
    const unpaired = async <T>(action: () => Promise<T>): Promise<T> => action();

    await runManagedBootstrap(
      {
        ...env,
        VERITY_SERVER_IMAGE: intermediate,
        VERITY_BOOTSTRAP_ADVANCE_IMAGE_FROM: digest,
      },
      'x64',
      env.VERITY_MANAGED_ROOT,
      unpaired,
    );
    await runManagedBootstrap(
      {
        ...env,
        VERITY_SERVER_IMAGE: latest,
        VERITY_BOOTSTRAP_ADVANCE_IMAGE_FROM: 'current',
      },
      'x64',
      env.VERITY_MANAGED_ROOT,
      unpaired,
    );

    const state = await readManagedDeployment(env.VERITY_MANAGED_ROOT!);
    expect(state.managed && state.spec.image).toBe(latest);
  });

  it('refuses an image advance when pairing completed after bootstrap began', async () => {
    const env = await environment();
    await runManagedBootstrap(env, 'x64', env.VERITY_MANAGED_ROOT);

    await expect(
      runManagedBootstrap(
        {
          ...env,
          VERITY_SERVER_IMAGE: `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`,
          VERITY_BOOTSTRAP_ADVANCE_IMAGE_FROM: digest,
        },
        'x64',
        env.VERITY_MANAGED_ROOT,
        async () => {
          throw new Error('the managed deployment is already paired');
        },
      ),
    ).rejects.toThrow(/already paired/);

    const state = await readManagedDeployment(env.VERITY_MANAGED_ROOT!);
    expect(state.managed && state.spec.image).toBe(digest);
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
