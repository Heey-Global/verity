import { chmod, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ServerDeploymentSpecBody } from './deployment-spec.js';
import {
  advanceManagedDeploymentImage,
  initializeManagedDeployment,
  MANAGED_DEPLOYMENT_MARKER_FILE,
  MANAGED_DEPLOYMENT_SPEC_FILE,
  readManagedDeployment,
  migrateManagedControlPlaneRunner,
} from './managed-deployment.js';

const adoptionSpec = (): Omit<ServerDeploymentSpecBody, 'schemaVersion' | 'deploymentId'> => ({
  image: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
  environment: [{ name: 'DATABASE_URL', source: { kind: 'env', name: 'DATABASE_URL' } }],
  mounts: [
    {
      source: { kind: 'volume', name: 'verity-data' },
      target: '/srv/verity',
      readOnly: false,
    },
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
  ],
  user: { uid: 1000, gid: 1000, supplementaryGids: [1101] },
  restart: 'unless-stopped',
  network: 'verity-net',
  platform: { os: 'linux', architecture: 'amd64' },
  security: { noNewPrivileges: true, readOnlyRootFilesystem: false, capAdd: ['CHOWN'] },
});

const root = () => mkdtemp(join(tmpdir(), 'verity-managed-deployment-'));

/** The Compose guardrails, spelled out rather than imported, so a change to the
 *  shipped defaults cannot silently rewrite what these tests assert. */
const LIMITS = {
  memoryBytes: 4 * 1024 ** 3,
  memorySwapBytes: 4 * 1024 ** 3,
  nanoCpus: 4_000_000_000,
  pidsLimit: 512,
};

describe('managed deployment bootstrap', () => {
  it('is unsupported before explicit initialization', async () => {
    expect(await readManagedDeployment(await root())).toEqual({
      managed: false,
      reason: 'managed deployment has not been initialized',
    });
  });

  it('atomically initializes and round-trips a sealed official deployment', async () => {
    const directory = await root();
    const initialized = await initializeManagedDeployment({
      root: directory,
      deploymentId: 'managed-1',
      spec: adoptionSpec(),
    });
    expect(initialized).toMatchObject({ managed: true, marker: { deploymentId: 'managed-1' } });
    expect(await readManagedDeployment(directory)).toEqual(initialized);
    expect(
      JSON.parse(await readFile(join(directory, MANAGED_DEPLOYMENT_SPEC_FILE), 'utf8')),
    ).toEqual(initialized.managed ? initialized.spec : undefined);
  });

  it('is idempotent and never changes the selected digest on restart', async () => {
    const directory = await root();
    const first = await initializeManagedDeployment({
      root: directory,
      deploymentId: 'managed-1',
      spec: adoptionSpec(),
    });
    const second = await initializeManagedDeployment({
      root: directory,
      deploymentId: 'managed-1',
      spec: {
        ...adoptionSpec(),
        image: `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`,
      },
    });
    expect(second).toEqual(first);
  });

  it('refuses mutable, custom, and literal-secret adoption', async () => {
    for (const spec of [
      { ...adoptionSpec(), image: 'ghcr.io/heey-global/verity/verity-server:latest' },
      { ...adoptionSpec(), image: `example.com/server@sha256:${'a'.repeat(64)}` },
      { ...adoptionSpec(), environment: [{ name: 'TOKEN', value: 'secret' }] as never },
    ]) {
      await expect(
        initializeManagedDeployment({ root: await root(), deploymentId: 'managed-1', spec }),
      ).rejects.toThrow(/not allowlisted/);
    }
  });

  it('fails closed for partial, corrupt, or identity-mismatched state', async () => {
    const partial = await root();
    await writeFile(join(partial, MANAGED_DEPLOYMENT_MARKER_FILE), '{"schemaVersion":1');
    expect(await readManagedDeployment(partial)).toEqual({
      managed: false,
      reason: 'managed deployment marker is invalid',
    });

    const mismatch = await root();
    await initializeManagedDeployment({
      root: mismatch,
      deploymentId: 'managed-1',
      spec: adoptionSpec(),
    });
    await writeFile(
      join(mismatch, MANAGED_DEPLOYMENT_MARKER_FILE),
      JSON.stringify({ schemaVersion: 1, deploymentId: 'managed-2' }),
    );
    expect(await readManagedDeployment(mismatch)).toEqual({
      managed: false,
      reason: 'managed deployment identity does not match its spec',
    });
  });

  it('does not overwrite recoverable partial state', async () => {
    const directory = await root();
    await writeFile(join(directory, MANAGED_DEPLOYMENT_SPEC_FILE), '{}');
    await expect(
      initializeManagedDeployment({
        root: directory,
        deploymentId: 'managed-1',
        spec: adoptionSpec(),
      }),
    ).rejects.toThrow(/managed deployment .* is invalid/);
  });

  it('rejects concurrent initialization without overwriting authority', async () => {
    const directory = await root();
    const attempts = await Promise.allSettled([
      initializeManagedDeployment({
        root: directory,
        deploymentId: 'managed-1',
        spec: adoptionSpec(),
      }),
      initializeManagedDeployment({
        root: directory,
        deploymentId: 'managed-2',
        spec: {
          ...adoptionSpec(),
          image: `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`,
        },
      }),
    ]);
    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const state = await readManagedDeployment(directory);
    expect(state).toMatchObject({ managed: true });
    if (state.managed) expect(['managed-1', 'managed-2']).toContain(state.spec.deploymentId);
  });

  it('rejects an existing authority for another deployment identity', async () => {
    const directory = await root();
    await initializeManagedDeployment({
      root: directory,
      deploymentId: 'managed-1',
      spec: adoptionSpec(),
    });
    await expect(
      initializeManagedDeployment({
        root: directory,
        deploymentId: 'managed-2',
        spec: adoptionSpec(),
      }),
    ).rejects.toThrow(/identity does not match/);
  });

  it('rejects a symlinked authority root', async () => {
    const parent = await root();
    const target = await root();
    const linkedRoot = join(parent, 'linked');
    await symlink(target, linkedRoot, 'dir');
    await expect(
      initializeManagedDeployment({
        root: linkedRoot,
        deploymentId: 'managed-1',
        spec: adoptionSpec(),
      }),
    ).rejects.toThrow(/private updater-owned directory/);
  });

  it('rejects an authority root writable by another principal', async () => {
    const directory = await root();
    await chmod(directory, 0o770);
    await expect(
      initializeManagedDeployment({
        root: directory,
        deploymentId: 'managed-1',
        spec: adoptionSpec(),
      }),
    ).rejects.toThrow(/private updater-owned directory/);
  });

  it('privatizes a fresh owner-controlled Docker volume root', async () => {
    const directory = await root();
    await chmod(directory, 0o755);
    await expect(
      initializeManagedDeployment({
        root: directory,
        deploymentId: 'managed-1',
        spec: adoptionSpec(),
      }),
    ).resolves.toMatchObject({ managed: true });
  });
});

describe('managed control-plane Runner migration', () => {
  const enabled = {
    VERITY_RUNNER_SUPERVISOR: '1',
    VERITY_CONTROL_PLANE_RUNNER: '1',
    VERITY_RUNNER_RUNTIME_GID: '1101',
  };

  const legacyAuthority = async () => {
    const directory = await root();
    await initializeManagedDeployment({
      root: directory,
      deploymentId: 'managed-1',
      spec: {
        ...adoptionSpec(),
        environment: [
          { name: 'DATABASE_URL', source: { kind: 'env', name: 'DATABASE_URL' } },
          {
            name: 'VERITY_RUNNER_SUPERVISOR',
            source: { kind: 'env', name: 'VERITY_RUNNER_SUPERVISOR' },
          },
        ],
      },
    });
    return directory;
  };

  it('atomically adds the dedicated Runner boundary to an eligible legacy authority', async () => {
    const directory = await legacyAuthority();
    const migrated = await migrateManagedControlPlaneRunner(directory, enabled);

    expect(migrated).toMatchObject({ managed: true });
    if (!migrated.managed) return;
    expect(migrated.spec.mounts).toEqual(
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
    expect(migrated.spec.environment).toEqual(
      expect.arrayContaining([
        {
          name: 'VERITY_CONTROL_PLANE_RUNNER',
          source: { kind: 'env', name: 'VERITY_CONTROL_PLANE_RUNNER' },
        },
        {
          name: 'VERITY_CONTROL_PLANE_RUNNER_IDENTITY_DIR',
          source: { kind: 'env', name: 'VERITY_CONTROL_PLANE_RUNNER_IDENTITY_DIR' },
        },
        // ADR 0006 Amendment 1's kill switch. A managed Server reads its
        // environment from the sealed spec, so a spec sealed before the switch
        // existed omits the name entirely — and the switch defaults ON. Without
        // this entry an operator sets it to 0 on an already-sealed host, sees no
        // error, and keeps the Docker socket: a switch that cannot be turned off
        // on the topology it ships to.
        {
          name: 'VERITY_CONTROL_PLANE_RUNNER_DOCKER',
          source: { kind: 'env', name: 'VERITY_CONTROL_PLANE_RUNNER_DOCKER' },
        },
      ]),
    );
    expect(await readManagedDeployment(directory)).toEqual(migrated);
    expect(await migrateManagedControlPlaneRunner(directory, enabled)).toEqual(migrated);
  });

  it('does not expand authority unless both Runner feature flags are enabled', async () => {
    const directory = await legacyAuthority();
    const before = await readManagedDeployment(directory);
    expect(
      await migrateManagedControlPlaneRunner(directory, {
        ...enabled,
        VERITY_CONTROL_PLANE_RUNNER: '0',
      }),
    ).toEqual(before);
    expect(await readManagedDeployment(directory)).toEqual(before);
  });

  it('completes an intermediate authority that already has both mounts', async () => {
    const directory = await legacyAuthority();
    const before = await readManagedDeployment(directory);
    if (!before.managed) throw new Error(before.reason);
    const { deploymentId } = before.spec;
    const spec = {
      image: before.spec.image,
      environment: before.spec.environment,
      mounts: before.spec.mounts,
      user: before.spec.user,
      restart: before.spec.restart,
      network: before.spec.network,
      platform: before.spec.platform,
      security: before.spec.security,
    };
    const intermediate = await root();
    await initializeManagedDeployment({
      root: intermediate,
      deploymentId,
      spec: {
        ...spec,
        mounts: [
          ...before.spec.mounts,
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
        ],
      },
    });

    const migrated = await migrateManagedControlPlaneRunner(intermediate, enabled);
    if (!migrated.managed) throw new Error(migrated.reason);
    expect(migrated.spec.mounts).toHaveLength(before.spec.mounts.length + 2);
    expect(migrated.spec.environment.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'VERITY_CONTROL_PLANE_RUNNER',
        'VERITY_CONTROL_PLANE_RUNNER_IDENTITY_DIR',
      ]),
    );
  });

  it('carries sealed resource limits through the migration without inventing them', async () => {
    const directory = await legacyAuthority();
    const before = await readManagedDeployment(directory);
    if (!before.managed) throw new Error(before.reason);
    // An authority sealed before the field must not GAIN it here: a Server older
    // than the field cannot parse a spec that has it, so a rollback below this
    // release would come back to an authority it can no longer read.
    const migrated = await migrateManagedControlPlaneRunner(directory, enabled);
    expect(migrated.managed && Object.hasOwn(migrated.spec, 'resources')).toBe(false);

    const limited = await root();
    await initializeManagedDeployment({
      root: limited,
      deploymentId: 'managed-1',
      spec: { ...adoptionSpec(), environment: before.spec.environment, resources: LIMITS },
    });
    const expanded = await migrateManagedControlPlaneRunner(limited, enabled);
    expect(expanded.managed && expanded.spec.resources).toEqual(LIMITS);
    expect(await readManagedDeployment(limited)).toEqual(expanded);
  });

  it('rejects a legacy authority without the pre-existing supervisor boundary', async () => {
    const directory = await root();
    await initializeManagedDeployment({
      root: directory,
      deploymentId: 'managed-1',
      spec: { ...adoptionSpec(), security: { ...adoptionSpec().security, capAdd: [] } },
    });
    await expect(migrateManagedControlPlaneRunner(directory, enabled)).rejects.toThrow(
      /not eligible/,
    );
  });
});

describe('managed deployment image advance', () => {
  const image = (character: string): string =>
    `ghcr.io/heey-global/verity/verity-server@sha256:${character.repeat(64)}`;
  const adopted = async () => {
    const directory = await root();
    const state = await initializeManagedDeployment({
      root: directory,
      deploymentId: 'managed-1',
      spec: adoptionSpec(),
    });
    return { directory, state };
  };

  it('re-seals the digest and changes nothing else', async () => {
    const { directory, state } = await adopted();
    const advanced = await advanceManagedDeploymentImage({
      root: directory,
      deploymentId: 'managed-1',
      fromImage: image('a'),
      toImage: image('b'),
    });
    expect(advanced).toEqual(await readManagedDeployment(directory));
    expect(advanced.managed && advanced.spec).toEqual({
      ...(state.managed ? state.spec : {}),
      image: image('b'),
      checksum: advanced.managed ? advanced.spec.checksum : '',
    });
    // Re-sealed, not merely rewritten: the old checksum never enters the hash.
    expect(advanced.managed && advanced.spec.checksum).not.toBe(
      state.managed ? state.spec.checksum : '',
    );
  });

  it('carries the sealed resource limits forward, and adds none to a spec without them', async () => {
    const directory = await root();
    await initializeManagedDeployment({
      root: directory,
      deploymentId: 'managed-1',
      spec: { ...adoptionSpec(), resources: LIMITS },
    });
    const advanced = await advanceManagedDeploymentImage({
      root: directory,
      deploymentId: 'managed-1',
      fromImage: image('a'),
      toImage: image('b'),
    });
    // Dropping them here would un-limit the control plane on the first
    // self-update after they were sealed, and tsc cannot flag a missing optional
    // property in the field-by-field body above.
    expect(advanced.managed && advanced.spec.resources).toEqual(LIMITS);
    expect(await readManagedDeployment(directory)).toEqual(advanced);

    const { directory: legacy } = await adopted();
    const unlimited = await advanceManagedDeploymentImage({
      root: legacy,
      deploymentId: 'managed-1',
      fromImage: image('a'),
      toImage: image('b'),
    });
    expect(unlimited.managed && Object.hasOwn(unlimited.spec, 'resources')).toBe(false);
  });

  it('is idempotent for a repeated advance and fenced against a stale view', async () => {
    const { directory } = await adopted();
    const advance = () =>
      advanceManagedDeploymentImage({
        root: directory,
        deploymentId: 'managed-1',
        fromImage: image('a'),
        toImage: image('b'),
      });
    expect(await advance()).toEqual(await advance());
    // A caller still believing 'a' is sealed has been overtaken by the one that
    // wrote 'b'; advancing to a third digest from that view is refused.
    await expect(
      advanceManagedDeploymentImage({
        root: directory,
        deploymentId: 'managed-1',
        fromImage: image('a'),
        toImage: image('c'),
      }),
    ).rejects.toThrow(/has moved since it was read/);
  });

  it('refuses a foreign identity and an uninitialized authority', async () => {
    const { directory } = await adopted();
    await expect(
      advanceManagedDeploymentImage({
        root: directory,
        deploymentId: 'managed-2',
        fromImage: image('a'),
        toImage: image('b'),
      }),
    ).rejects.toThrow(/identity does not match/);
    await expect(
      advanceManagedDeploymentImage({
        root: await root(),
        deploymentId: 'managed-1',
        fromImage: image('a'),
        toImage: image('b'),
      }),
    ).rejects.toThrow(/has not been initialized/);
  });

  it('leaves the previous authority readable when the target is not allowlisted', async () => {
    const { directory, state } = await adopted();
    await expect(
      advanceManagedDeploymentImage({
        root: directory,
        deploymentId: 'managed-1',
        fromImage: image('a'),
        toImage: 'ghcr.io/heey-global/verity/verity-server:latest',
      }),
    ).rejects.toThrow(/not allowlisted/);
    expect(await readManagedDeployment(directory)).toEqual(state);
  });
});
