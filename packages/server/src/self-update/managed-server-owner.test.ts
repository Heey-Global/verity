import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerInspect } from '../docker.js';
import {
  parseServerDeploymentSpec,
  sealDeploymentSpec,
  type ServerDeploymentSpec,
  type ServerDeploymentSpecBody,
  type ServerDeploymentSpecResources,
} from './deployment-spec.js';
import { initializeManagedDeployment } from './managed-deployment.js';
import {
  describeManagedContainerMismatch,
  MANAGED_DEPLOYMENT_LABEL,
  MANAGED_ROLE_LABEL,
  MANAGED_SERVER_NAME,
  managedContainerMatchesSpec,
  managedServerContainerSpec,
  reconcileManagedServer,
  sealedHostLimitsMode,
  type ManagedServerDocker,
} from './managed-server-owner.js';

const body = (
  extraEnvironment: ServerDeploymentSpecBody['environment'] = [],
): Omit<ServerDeploymentSpecBody, 'schemaVersion' | 'deploymentId'> => ({
  image: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
  environment: [
    { name: 'DATABASE_URL', source: { kind: 'env', name: 'DATABASE_URL' } },
    {
      name: 'VERITY_MANAGED_DEPLOYMENT_ID',
      source: { kind: 'env', name: 'VERITY_MANAGED_DEPLOYMENT_ID' },
    },
    { name: 'TOKEN', source: { kind: 'file', path: '/run/secrets/token' } },
    ...extraEnvironment,
  ],
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
  ],
  user: { uid: 1000, gid: 1000, supplementaryGids: [999, 1101] },
  restart: 'unless-stopped',
  network: 'verity-net',
  platform: { os: 'linux', architecture: 'amd64' },
  security: { noNewPrivileges: true, readOnlyRootFilesystem: false, capAdd: ['CHOWN'] },
});

// What the Server image itself bakes in. A real daemon reports a container's
// `Config.Env` as these WITH the create request applied on top, and reports a
// volume mount's `Source` as the host path rather than the volume name — so the
// fixtures below mirror both, or they would assert against a Docker that does
// not exist. `PORT` is deliberately also set by the spec: the container value
// must win exactly once, not appear twice.
const IMAGE_ENV = [
  'PATH=/usr/local/bin:/usr/bin:/bin',
  'NODE_VERSION=24.19.0',
  'NODE_ENV=production',
  'PORT=8082',
  'VERITY_ROOT=/srv/verity',
];

const volumeHostPath = (name: string): string => `/var/lib/docker/volumes/${name}/_data`;

async function authority(
  extraEnvironment: ServerDeploymentSpecBody['environment'] = [],
  resources?: ServerDeploymentSpecResources,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'managed-server-owner-'));
  await initializeManagedDeployment({
    root,
    deploymentId: 'deployment-1',
    spec: {
      ...body(extraEnvironment),
      ...(resources === undefined ? {} : { resources }),
    },
  });
  return root;
}

function docker(
  existing?: ContainerInspect,
  name: string = MANAGED_SERVER_NAME,
  imageEnv: readonly string[] = IMAGE_ENV,
): ManagedServerDocker & {
  createContainer: ReturnType<typeof vi.fn>;
  startContainer: ReturnType<typeof vi.fn>;
  pullImage: ReturnType<typeof vi.fn>;
  removeContainer: ReturnType<typeof vi.fn>;
} {
  return {
    listContainers: vi.fn(async () =>
      existing === undefined ? [] : [{ id: existing.id, imageId: 'sha256:image', names: [name] }],
    ),
    inspectContainer: vi.fn(async () => {
      if (existing === undefined) throw new Error('unexpected inspect');
      return existing;
    }),
    createContainer: vi.fn(async () => ({ id: 'created', warnings: [] })),
    startContainer: vi.fn(async () => undefined),
    pullImage: vi.fn(async () => undefined),
    removeContainer: vi.fn(async () => undefined),
    inspectImageEnv: vi.fn(async () => imageEnv),
  };
}

function owned(running: boolean): ContainerInspect {
  return {
    id: 'existing',
    running,
    image: body().image,
    labels: {
      [MANAGED_DEPLOYMENT_LABEL]: 'deployment-1',
      [MANAGED_ROLE_LABEL]: 'server',
    },
    user: '1000:1000',
    networkMode: 'verity-net',
    readOnlyRootfs: false,
    restartPolicy: 'unless-stopped',
    securityOpt: ['no-new-privileges:true'],
    capAdd: ['CHOWN'],
    groupAdd: ['999', '1101'],
    env: [
      ...IMAGE_ENV,
      'DATABASE_URL=postgres://db',
      'VERITY_MANAGED_DEPLOYMENT_ID=deployment-1',
      'TOKEN=secret',
    ],
    command: ['node', 'dist/main.js'],
    mounts: [
      {
        type: 'volume',
        name: 'verity-data',
        source: volumeHostPath('verity-data'),
        destination: '/srv/verity',
        readWrite: true,
      },
      {
        type: 'volume',
        name: 'verity-agent-gateway-control',
        source: volumeHostPath('verity-agent-gateway-control'),
        destination: '/run/verity-agent-gateway',
        readWrite: true,
      },
      {
        type: 'bind',
        source: '/var/run/docker.sock',
        destination: '/var/run/docker.sock',
        readWrite: true,
      },
    ],
    init: true,
  };
}

function runtimeOptions(managedRoot: string, client: ManagedServerDocker) {
  return {
    managedRoot,
    docker: client,
    environment: {
      DATABASE_URL: 'postgres://db',
      VERITY_MANAGED_DEPLOYMENT_ID: 'deployment-1',
    },
    readFile: async () => 'secret',
  };
}

/** A sealed spec built in memory, with no updater-owned root behind it — the one
 *  way to exercise `managedServerContainerSpec` without `/proc/self/fd`. */
function sealed(
  resources?: ServerDeploymentSpecResources,
  extraEnvironment: ServerDeploymentSpecBody['environment'] = [],
): ServerDeploymentSpec {
  const spec = parseServerDeploymentSpec(
    sealDeploymentSpec({
      ...body(extraEnvironment),
      schemaVersion: 2,
      deploymentId: 'deployment-1',
      ...(resources === undefined ? {} : { resources }),
    }),
  );
  if (spec === null) throw new Error('fixture spec is not allowlisted');
  return spec;
}

const containerSpec = (spec: ServerDeploymentSpec) =>
  managedServerContainerSpec(
    spec,
    { DATABASE_URL: 'postgres://db', VERITY_MANAGED_DEPLOYMENT_ID: 'deployment-1' },
    async () => 'secret',
  );

describe('managed Server host limits', () => {
  it('gives a Server sealed before the limits existed the Compose guardrails', async () => {
    const spec = sealed();
    // The old-spec/new-Server direction: the authority states nothing, and the
    // container is still built with what Compose gave the `verity` service.
    expect(Object.hasOwn(spec, 'resources')).toBe(false);
    expect(await containerSpec(spec)).toMatchObject({
      memoryBytes: 4 * 1024 ** 3,
      memorySwapBytes: 4 * 1024 ** 3,
      nanoCpus: 4_000_000_000,
      pidsLimit: 512,
    });
  });

  it('prefers the sealed limits over the Compose fallback', async () => {
    const spec = sealed({
      memoryBytes: 8 * 1024 ** 3,
      memorySwapBytes: 8 * 1024 ** 3,
      nanoCpus: 6_000_000_000,
      pidsLimit: 1024,
    });
    expect(await containerSpec(spec)).toMatchObject({
      memoryBytes: 8 * 1024 ** 3,
      memorySwapBytes: 8 * 1024 ** 3,
      nanoCpus: 6_000_000_000,
      pidsLimit: 1024,
    });
  });

  /** A container reported exactly as the sealed spec describes, including the
   *  ceilings a daemon would report for one created from it. */
  const limited = (overrides: Partial<ContainerInspect> = {}): ContainerInspect => ({
    ...owned(true),
    memoryBytes: 4 * 1024 ** 3,
    memorySwapBytes: 4 * 1024 ** 3,
    nanoCpus: 4_000_000_000,
    pidsLimit: 512,
    ...overrides,
  });

  it('accepts a candidate whose ceilings are the sealed ones', async () => {
    const desired = await containerSpec(sealed());
    expect(managedContainerMatchesSpec(limited(), desired, IMAGE_ENV, false, 'exact')).toBe(true);
  });

  it.each([
    // The whole point of the guardrail: a candidate created before the ceilings
    // existed reports Docker's "unlimited" for each of them.
    ['no ceilings at all', { memoryBytes: 0, memorySwapBytes: 0, nanoCpus: 0, pidsLimit: 0 }],
    ['no ceilings reported at all', {}],
    ['a smaller memory ceiling', { memoryBytes: 2 * 1024 ** 3 }],
    // The dangerous one: memory looks right, but Docker was left to default the
    // combined ceiling, which grants swap the spec denies.
    ['a defaulted swap allowance', { memorySwapBytes: 0 }],
    ['unlimited swap', { memorySwapBytes: -1 }],
    ['more CPU', { nanoCpus: 8_000_000_000 }],
    ['no fork-bomb guard', { pidsLimit: -1 }],
  ])('refuses a candidate with %s', async (_label, drift) => {
    const legacy = sealed();
    const desired = await containerSpec(legacy);
    // An empty drift means the container reports no ceiling fields at all, which
    // is the pre-change shape rather than a modified one.
    const inspect = Object.keys(drift).length === 0 ? owned(true) : limited(drift);
    expect(managedContainerMatchesSpec(inspect, desired, IMAGE_ENV, false, 'exact')).toBe(false);
    // The same container is still the sealed Server for a reconcile that merely
    // FINDS it running under an authority that states no ceilings. Deleting that
    // tolerance — "tidying up" the split — turns every host whose Server predates
    // the ceilings into an Updater crash loop, so it is asserted rather than left
    // to a comment.
    const tolerated = sealedHostLimitsMode(legacy);
    expect(tolerated).toBe('ignored');
    expect(managedContainerMatchesSpec(inspect, desired, IMAGE_ENV, false, tolerated)).toBe(true);
    expect(managedContainerMatchesSpec(inspect, desired, IMAGE_ENV, true, tolerated)).toBe(true);
  });

  it('refuses a running Server whose sealed ceilings have been weakened', async () => {
    // The authority STATES its ceilings, so every Server it has ever produced was
    // created with them and an unlimited container cannot be the sealed one.
    const authoritative = sealed({
      memoryBytes: 4 * 1024 ** 3,
      memorySwapBytes: 4 * 1024 ** 3,
      nanoCpus: 4_000_000_000,
      pidsLimit: 512,
    });
    const desired = await containerSpec(authoritative);
    const mode = sealedHostLimitsMode(authoritative);
    expect(mode).toBe('exact');
    const drifted = limited({ memoryBytes: 0, memorySwapBytes: 0, nanoCpus: 0, pidsLimit: 0 });
    expect(managedContainerMatchesSpec(drifted, desired, IMAGE_ENV, false, mode)).toBe(false);
    expect(managedContainerMatchesSpec(drifted, desired, IMAGE_ENV, true, mode)).toBe(false);
    // Unchanged ceilings still reconcile, or the guardrail would refuse every
    // healthy Server it protects.
    expect(managedContainerMatchesSpec(limited(), desired, IMAGE_ENV, true, mode)).toBe(true);
  });

  it('tolerates a generation-identified container under an authority with no ceilings', async () => {
    // `promoted = false` is the generation-identified reconcile, and it is NOT a
    // fresh candidate: `recoverManagedUpdater` reaches it for the terminal
    // `completed`/`rolled-back` phases with the identity taken from the Gateway's
    // selected backend — the Server that is already routed. On a deployment whose
    // last update ran before the ceilings existed, that container has none, and a
    // refusal here is fatal rather than repaired. Keying exactness off the
    // identity instead of the authority would wedge every host that has completed
    // an update.
    const legacy = sealed();
    const desired = await containerSpec(legacy);
    const preLimits = limited({ memoryBytes: 0, memorySwapBytes: 0, nanoCpus: 0, pidsLimit: 0 });
    expect(
      managedContainerMatchesSpec(
        preLimits,
        desired,
        IMAGE_ENV,
        false,
        sealedHostLimitsMode(legacy),
      ),
    ).toBe(true);
  });

  it('still refuses a candidate that drifts in something other than a ceiling', async () => {
    const desired = await containerSpec(sealed());
    // Guards the assertion above: the "ignored" mode must keep every other field
    // exact, or it would be proving nothing.
    expect(managedContainerMatchesSpec(limited({ user: '0:0' }), desired, IMAGE_ENV, false)).toBe(
      false,
    );
  });
});

/**
 * The sealed spec outlives the Compose file it was sealed from. Removing a variable
 * from `deploy/docker-compose.yml` therefore leaves every deployment sealed before
 * that removal naming a source nothing supplies, and the Updater resolves every
 * source on every reconcile — so the removal lands as a crash loop on hosts that
 * cannot update themselves out of it, which is how the fix would reach them.
 */
describe('retired managed Server environment', () => {
  const retiredEntry = (name: string): ServerDeploymentSpecBody['environment'] => [
    { name, source: { kind: 'env' as const, name } },
  ];
  /** What the Updater's own environment looks like once Compose stopped supplying
   *  the retired variable: exactly the sources a current deployment still has. */
  const withoutRetired = {
    DATABASE_URL: 'postgres://db',
    VERITY_MANAGED_DEPLOYMENT_ID: 'deployment-1',
  };

  it('builds the Server without a variable the deployment has retired', async () => {
    const spec = sealed(undefined, retiredEntry('VERITY_LOCAL_TRANSCRIBE_AVAILABLE'));

    const desired = await managedServerContainerSpec(spec, withoutRetired, async () => 'secret');

    expect(
      desired.env?.some((entry) => entry.startsWith('VERITY_LOCAL_TRANSCRIBE_AVAILABLE=')),
    ).toBe(false);
    // Everything the deployment DOES still supply is untouched: the tolerance is
    // the recorded name, not "resolve what you can".
    expect(desired.env).toContain('DATABASE_URL=postgres://db');
    expect(desired.env).toContain('TOKEN=secret');
  });

  it('still refuses a source that is missing for any other reason', async () => {
    // The distinction the whole mechanism rests on. A variable the Server reads and
    // the deployment has lost is a broken deployment, and building a Server without
    // it would trade a correct refusal for one silently running on defaults.
    const spec = sealed(undefined, retiredEntry('VERITY_AGENT_GATEWAY_UNSEAL_KEY'));

    await expect(
      managedServerContainerSpec(spec, withoutRetired, async () => 'secret'),
    ).rejects.toThrow(
      'managed Server environment source is missing: VERITY_AGENT_GATEWAY_UNSEAL_KEY',
    );
  });

  it('keeps the running Server that was created while the variable still existed', async () => {
    // The other half of the same fix. The Server on a host in this state was created
    // by an Updater whose Compose environment still had the variable, so dropping it
    // from `desired` alone only moves the crash loop into the comparison —
    // reconciliation throws on a mismatch and never recreates.
    const desired = await managedServerContainerSpec(
      sealed(undefined, retiredEntry('VERITY_LOCAL_TRANSCRIBE_AVAILABLE')),
      withoutRetired,
      async () => 'secret',
    );
    const running = {
      ...owned(true),
      env: [...owned(true).env!, 'VERITY_LOCAL_TRANSCRIBE_AVAILABLE=true'],
    };

    expect(managedContainerMatchesSpec(running, desired, IMAGE_ENV, true)).toBe(true);
    // And for a candidate too: preparation builds one from this spec so it never
    // carries the variable, but one a PREVIOUS Updater prepared does, and refusing
    // that wedges an update mid-flight.
    expect(managedContainerMatchesSpec(running, desired, IMAGE_ENV, false)).toBe(true);
  });

  it('still notices an extra variable that is not a retired one', async () => {
    // Guards the assertion above: the comparison must stay exact everywhere else, or
    // it would be proving nothing.
    const desired = await managedServerContainerSpec(
      sealed(undefined, retiredEntry('VERITY_LOCAL_TRANSCRIBE_AVAILABLE')),
      withoutRetired,
      async () => 'secret',
    );
    const running = {
      ...owned(true),
      env: [...owned(true).env!, 'VERITY_LOCAL_TRANSCRIBE_MOUNT=/injected'],
    };

    expect(managedContainerMatchesSpec(running, desired, IMAGE_ENV, true)).toBe(false);
  });
});

describe('managed Server ownership', () => {
  it('creates exactly the sealed Server configuration and starts it', async () => {
    const client = docker();
    await expect(
      reconcileManagedServer({
        managedRoot: await authority(),
        docker: client,
        environment: {
          DATABASE_URL: 'postgres://db',
          VERITY_MANAGED_DEPLOYMENT_ID: 'deployment-1',
        },
        readFile: vi.fn(async () => 'secret\n'),
      }),
    ).resolves.toEqual({ containerId: 'created', action: 'created' });
    expect(client.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: MANAGED_SERVER_NAME,
        env: [
          'DATABASE_URL=postgres://db',
          'VERITY_MANAGED_DEPLOYMENT_ID=deployment-1',
          'TOKEN=secret',
        ],
        user: '1000:1000',
        groupAdd: ['999', '1101'],
        platform: 'linux/amd64',
        memoryBytes: 4 * 1024 ** 3,
        memorySwapBytes: 4 * 1024 ** 3,
        nanoCpus: 4_000_000_000,
        pidsLimit: 512,
        labels: {
          [MANAGED_DEPLOYMENT_LABEL]: 'deployment-1',
          [MANAGED_ROLE_LABEL]: 'server',
        },
      }),
    );
    expect(client.startContainer).toHaveBeenCalledWith('created');
  });

  it('refuses a running Server whose ceilings drifted below its sealed authority', async () => {
    // Created with the ceilings the authority states, then modified to unlimited.
    // Nothing in the update path can produce that, so it is refused rather than
    // silently kept as the control plane.
    const unlimited = {
      ...owned(true),
      memoryBytes: 0,
      memorySwapBytes: 0,
      nanoCpus: 0,
      pidsLimit: 0,
    };
    const client = docker(unlimited);
    const root = await authority([], {
      memoryBytes: 4 * 1024 ** 3,
      memorySwapBytes: 4 * 1024 ** 3,
      nanoCpus: 4_000_000_000,
      pidsLimit: 512,
    });
    await expect(reconcileManagedServer(runtimeOptions(root, client))).rejects.toThrow(
      /managed Server container conflicts with the sealed deployment spec/,
    );
  });

  it('keeps an identical container when the sealed authority states no ceilings', async () => {
    // The same container under a legacy authority. This is the crash-loop guard:
    // every deployment adopted before the ceilings existed reaches exactly here on
    // every Updater start, and a refusal would be fatal and unrecoverable.
    const unlimited = {
      ...owned(true),
      memoryBytes: 0,
      memorySwapBytes: 0,
      nanoCpus: 0,
      pidsLimit: 0,
    };
    const client = docker(unlimited);
    await expect(
      reconcileManagedServer(runtimeOptions(await authority(), client)),
    ).resolves.toEqual({ containerId: 'existing', action: 'unchanged' });
  });

  it('leaves a matching running container unchanged and restarts a stopped one', async () => {
    const running = docker(owned(true));
    await expect(
      reconcileManagedServer(runtimeOptions(await authority(), running)),
    ).resolves.toEqual({ containerId: 'existing', action: 'unchanged' });
    expect(running.startContainer).not.toHaveBeenCalled();

    const stopped = docker(owned(false));
    await expect(
      reconcileManagedServer(runtimeOptions(await authority(), stopped)),
    ).resolves.toEqual({ containerId: 'existing', action: 'started' });
    expect(stopped.startContainer).toHaveBeenCalledWith('existing');
  });

  it('refuses foreign ownership and sealed-spec drift without mutating Docker', async () => {
    for (const inspect of [
      { ...owned(true), labels: { [MANAGED_ROLE_LABEL]: 'server' } },
      { ...owned(true), image: `ghcr.io/foreign@sha256:${'b'.repeat(64)}` },
    ]) {
      const client = docker(inspect);
      await expect(
        reconcileManagedServer(runtimeOptions(await authority(), client)),
      ).rejects.toThrow(/foreign|conflicts/);
      expect(client.createContainer).not.toHaveBeenCalled();
      expect(client.startContainer).not.toHaveBeenCalled();
    }
  });

  // The container's environment is the image's with the spec applied on top, so
  // it can be neither compared against the spec alone (nothing would ever match)
  // nor merely searched for the spec's entries (an injected variable would pass).
  it('accepts the image environment but no variable beyond the sealed spec', async () => {
    await expect(
      reconcileManagedServer(runtimeOptions(await authority(), docker(owned(true)))),
    ).resolves.toEqual({ containerId: 'existing', action: 'unchanged' });

    for (const env of [
      // Neither sealed nor baked: an injected variable, which is the case this
      // whole comparison was written to catch. It stays fatal — the drift
      // tolerance is scoped to names the SEALED SPEC supplies, so widening it
      // could never reach this one.
      [...owned(true).env!, 'NODE_OPTIONS=--require /injected.js'],
      // Baked by the image and overridden on the container. The spec does not
      // supply `NODE_ENV`, so nothing legitimate can have moved its value.
      [...owned(true).env!.filter((entry) => !entry.startsWith('NODE_ENV=')), 'NODE_ENV=debug'],
      // A sealed name the container does not carry. Tolerance covers a value
      // that MOVED, never one that is gone: this Server is running without a
      // variable the authority requires, and keeping it would be the "running on
      // defaults" outcome rather than a recovery from anything.
      owned(true).env!.filter((entry) => !entry.startsWith('TOKEN=')),
    ]) {
      const client = docker({ ...owned(true), env });
      await expect(
        reconcileManagedServer(runtimeOptions(await authority(), client)),
      ).rejects.toThrow(/conflicts/);
      expect(client.startContainer).not.toHaveBeenCalled();
      expect(client.removeContainer).not.toHaveBeenCalled();
    }
  });

  it('reuses a promoted generation whose image bakes a different relay reference', async () => {
    // Both sides carry the variable and disagree: the container was created with the
    // relay of the release that promoted it, while the Updater — which replaced
    // itself during that same update — now resolves the newer one. That is not
    // drift, and refusing it would stop the Updater from starting at all.
    const older = `ghcr.io/heey-global/verity/verity-project-relay@sha256:${'b'.repeat(64)}`;
    const newer = `ghcr.io/heey-global/verity/verity-project-relay@sha256:${'c'.repeat(64)}`;
    const promoted = {
      ...owned(true),
      env: [...owned(true).env!, `VERITY_BUNDLED_PROJECT_RELAY_IMAGE=${older}`],
    };

    await expect(
      reconcileManagedServer(
        runtimeOptions(
          await authority(),
          docker(promoted, MANAGED_SERVER_NAME, [
            ...IMAGE_ENV,
            `VERITY_BUNDLED_PROJECT_RELAY_IMAGE=${newer}`,
          ]),
        ),
      ),
    ).resolves.toEqual({ containerId: 'existing', action: 'unchanged' });
  });

  it('recreates a missing Server without the legacy sealed relay reference', async () => {
    // A deployment sealed before the bootstrap stopped forwarding it still names the
    // relay as an env source. Resolved here it would come from the CURRENT Updater —
    // a different release than the image being started — and override the bundled
    // reference that image was published with.
    const stale = `ghcr.io/heey-global/verity/verity-project-relay@sha256:${'e'.repeat(64)}`;
    const root = await authority([
      {
        name: 'VERITY_BUNDLED_PROJECT_RELAY_IMAGE',
        source: { kind: 'env', name: 'VERITY_BUNDLED_PROJECT_RELAY_IMAGE' },
      },
    ]);
    const client = docker();

    await expect(
      reconcileManagedServer({
        ...runtimeOptions(root, client),
        environment: {
          DATABASE_URL: 'postgres://db',
          VERITY_MANAGED_DEPLOYMENT_ID: 'deployment-1',
          VERITY_BUNDLED_PROJECT_RELAY_IMAGE: stale,
        },
      }),
    ).resolves.toEqual({ containerId: 'created', action: 'created' });

    const [spec] = client.createContainer.mock.calls[0] as [{ env?: string[] }];
    expect(spec.env?.some((entry) => entry.startsWith('VERITY_BUNDLED_PROJECT_RELAY_IMAGE='))).toBe(
      false,
    );
    expect(spec.env).toContain('DATABASE_URL=postgres://db');
  });

  it('refuses a candidate whose only difference is the bundled relay reference', async () => {
    // Mid-update the relay reference matters: a candidate left over from an earlier
    // attempt may carry one from another release, and adopting it would pin the
    // Server that gets promoted to that relay.
    const identity = {
      name: 'verity-managed-server-g7',
      operationId: 'generation-7',
      generation: 7,
    };
    const stale = {
      ...owned(true),
      env: [
        ...owned(true).env!,
        'VERITY_CONTROL_PLANE_WAIT_FOR_ACTIVATION=1',
        `VERITY_UPDATE_ID=${identity.operationId}`,
        `VERITY_CONTROL_PLANE_HOLDER_ID=${identity.name}`,
        `VERITY_BUNDLED_PROJECT_RELAY_IMAGE=ghcr.io/heey-global/verity/verity-project-relay@sha256:${'d'.repeat(64)}`,
      ],
    };
    const client = docker(stale, identity.name);

    await expect(
      reconcileManagedServer({ ...runtimeOptions(await authority(), client), identity }),
    ).rejects.toThrow(/conflicts/);
    expect(client.startContainer).not.toHaveBeenCalled();
  });

  /** A generation-identified container: what `recoverManagedUpdater` reconciles
   *  for the terminal phases, taken from the Gateway's selected backend. */
  const generation = { name: 'verity-managed-server-g7', operationId: 'op-7', generation: 7 };
  const routedGeneration = (ceilings: Partial<ContainerInspect>): ContainerInspect => ({
    ...owned(true),
    env: [
      ...owned(true).env!,
      'VERITY_CONTROL_PLANE_WAIT_FOR_ACTIVATION=1',
      `VERITY_UPDATE_ID=${generation.operationId}`,
      `VERITY_CONTROL_PLANE_HOLDER_ID=${generation.name}`,
    ],
    ...ceilings,
  });

  it('adopts a generation whose ceilings predate the release, under a legacy authority', async () => {
    // THE crash-loop case, and the reason exactness is keyed off the sealed
    // authority rather than off `identity`. The promoted Server of any deployment
    // that completed an update before this release is exactly this container:
    // created by the previous Updater from `dockerUpdatePreparation`, kept by the
    // cutover (`activateCandidate` starts the prepared container and `retireOld`
    // removes the other one), and named by the Gateway backend on every later
    // Updater start. `recoverManagedUpdater` rethrows a failure here whenever no
    // operation is in flight, and `completed` is terminal — so refusing it would
    // be a permanent crash loop with no path out.
    const client = docker(
      routedGeneration({ memoryBytes: 0, memorySwapBytes: 0, nanoCpus: 0, pidsLimit: 0 }),
      generation.name,
    );
    await expect(
      reconcileManagedServer({
        ...runtimeOptions(await authority(), client),
        identity: generation,
      }),
    ).resolves.toEqual({ containerId: 'existing', action: 'unchanged' });
  });

  it('refuses a generation whose ceilings drifted below a sealing authority', async () => {
    // Same container, but the authority STATES its ceilings — so it was adopted by
    // a release that has this code, every Server it produced was created with them,
    // and an unlimited one cannot be honest.
    const client = docker(
      routedGeneration({ memoryBytes: 0, memorySwapBytes: 0, nanoCpus: 0, pidsLimit: 0 }),
      generation.name,
    );
    const root = await authority([], {
      memoryBytes: 4 * 1024 ** 3,
      memorySwapBytes: 4 * 1024 ** 3,
      nanoCpus: 4_000_000_000,
      pidsLimit: 512,
    });
    await expect(
      reconcileManagedServer({ ...runtimeOptions(root, client), identity: generation }),
    ).rejects.toThrow(/managed Server container conflicts with the sealed deployment spec/);
    expect(client.startContainer).not.toHaveBeenCalled();
  });

  it('still compares a candidate exactly, so it cannot join the wrong activation', async () => {
    // Mid-update the same variables are the activation handshake itself. A standby
    // container naming a different operation must be refused, not adopted.
    const identity = { name: 'verity-managed-server-g7', operationId: 'op-current', generation: 7 };
    const candidate = {
      ...owned(true),
      env: [
        ...owned(true).env!,
        'VERITY_CONTROL_PLANE_WAIT_FOR_ACTIVATION=1',
        'VERITY_UPDATE_ID=op-from-an-earlier-attempt',
        `VERITY_CONTROL_PLANE_HOLDER_ID=${identity.name}`,
      ],
    };
    const client = docker(candidate, identity.name);

    await expect(
      reconcileManagedServer({
        ...runtimeOptions(await authority(), client),
        identity,
      }),
    ).rejects.toThrow(/conflicts/);
    expect(client.startContainer).not.toHaveBeenCalled();
  });

  // The daemon reports a volume's `Source` as the host path it resolves to, which
  // is neither the volume name nor stable across hosts.
  it('matches a volume mount by name, not by the host path it resolves to', async () => {
    const relocated = owned(true).mounts!.map((mount) =>
      mount.type === 'volume' ? { ...mount, source: `/mnt/pool${String(mount.source)}` } : mount,
    );
    await expect(
      reconcileManagedServer(
        runtimeOptions(await authority(), docker({ ...owned(true), mounts: relocated })),
      ),
    ).resolves.toEqual({ containerId: 'existing', action: 'unchanged' });

    const swapped = owned(true).mounts!.map((mount) =>
      mount.name === 'verity-data' ? { ...mount, name: 'verity-data-copy' } : mount,
    );
    await expect(
      reconcileManagedServer(
        runtimeOptions(await authority(), docker({ ...owned(true), mounts: swapped })),
      ),
    ).rejects.toThrow(/conflicts/);
  });

  it('refuses to start with a deployment ID that differs from the sealed authority', async () => {
    const client = docker();
    await expect(
      reconcileManagedServer({
        ...runtimeOptions(await authority(), client),
        environment: {
          DATABASE_URL: 'postgres://db',
          VERITY_MANAGED_DEPLOYMENT_ID: 'another-deployment',
        },
      }),
    ).rejects.toThrow(/deployment ID does not match/);
    expect(client.createContainer).not.toHaveBeenCalled();
  });

  it('pulls the sealed image once after image-not-found and retries creation', async () => {
    const client = docker();
    client.createContainer
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { kind: 'image_not_found' }))
      .mockResolvedValueOnce({ id: 'created-after-pull', warnings: [] });
    await expect(
      reconcileManagedServer({
        managedRoot: await authority(),
        docker: client,
        environment: {
          DATABASE_URL: 'postgres://db',
          VERITY_MANAGED_DEPLOYMENT_ID: 'deployment-1',
        },
        readFile: async () => 'secret',
      }),
    ).resolves.toEqual({ containerId: 'created-after-pull', action: 'created' });
    expect(client.pullImage).toHaveBeenCalledWith(body().image);
    expect(client.createContainer).toHaveBeenCalledTimes(2);
  });

  it('adopts only the same sealed owner after a concurrent create wins', async () => {
    const client = docker(owned(true));
    const list = client.listContainers as ReturnType<typeof vi.fn>;
    list
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'existing', imageId: 'sha256:image', names: [MANAGED_SERVER_NAME] },
      ]);
    client.createContainer.mockRejectedValueOnce(
      Object.assign(new Error('name conflict'), { kind: 'conflict' }),
    );
    await expect(
      reconcileManagedServer(runtimeOptions(await authority(), client)),
    ).resolves.toEqual({ containerId: 'existing', action: 'unchanged' });
    expect(client.startContainer).not.toHaveBeenCalled();
  });

  /**
   * A deployment sealed before a variable was retired still names it as an env
   * SOURCE, because every generation copies the sealed environment forward — a
   * release never rewrites it. Whether the Updater's own Compose service happens to
   * still carry a compensating value must not decide whether it starts at all: with
   * the value it used to reconcile and without it used to crash-loop, which is the
   * #1553 outage. Both halves below now reconcile, and neither hands the retired
   * variable to the Server.
   */
  it('reconciles a seal naming a retired source, with or without the Compose value', async () => {
    const spec = body();
    const sealed = {
      ...spec,
      environment: [
        ...spec.environment,
        {
          name: 'VERITY_PREVIEW_DOMAIN',
          source: { kind: 'env' as const, name: 'VERITY_PREVIEW_DOMAIN' },
        },
        {
          name: 'VERITY_LOCAL_TRANSCRIBE_AVAILABLE',
          source: { kind: 'env' as const, name: 'VERITY_LOCAL_TRANSCRIBE_AVAILABLE' },
        },
      ],
    };
    const root = await mkdtemp(join(tmpdir(), 'managed-server-owner-'));
    await initializeManagedDeployment({ root, deploymentId: 'deployment-1', spec: sealed });
    const current = {
      DATABASE_URL: 'postgres://db',
      VERITY_MANAGED_DEPLOYMENT_ID: 'deployment-1',
    };

    for (const environment of [current, { ...current, VERITY_PREVIEW_DOMAIN: '' }]) {
      const client = docker();
      await expect(
        reconcileManagedServer({
          managedRoot: root,
          docker: client,
          environment,
          readFile: async () => 'secret',
        }),
      ).resolves.toEqual({ containerId: 'created', action: 'created' });
      const [created] = client.createContainer.mock.calls[0] as [{ env?: string[] }];
      expect(created.env).toEqual([
        'DATABASE_URL=postgres://db',
        'VERITY_MANAGED_DEPLOYMENT_ID=deployment-1',
        'TOKEN=secret',
      ]);
    }
  });
});

/**
 * An environment mismatch between the sealed spec and the running Server used to
 * be an unrecoverable crash loop: `reconcileManagedServer` threw, never recreated,
 * and `recoverManagedUpdater` rethrew with nothing in flight — so the Updater
 * restarted forever and the one operation that rebuilds the Server with the
 * current environment, the cutover, was exactly what had become unreachable.
 *
 * The refusal was right and the exit was not. These pin the split: which
 * differences are still the container being the wrong container, and which are
 * merely the same container carrying an older resolution of the same sources.
 */
describe('managed Server environment drift', () => {
  const drifted = (env: readonly string[], from: string, to: string): string[] =>
    env.map((entry) => (entry.startsWith(`${from}=`) ? `${from}=${to}` : entry));

  describe('classification', () => {
    const classify = async (
      inspect: ContainerInspect,
      promoted = true,
    ): Promise<ReturnType<typeof describeManagedContainerMismatch>> =>
      describeManagedContainerMismatch(inspect, await containerSpec(sealed()), IMAGE_ENV, promoted);

    it('calls an identical container a match', async () => {
      expect(await classify(owned(true))).toBe('match');
    });

    it.each([
      // A value the host now resolves differently — the #1576 class, and the one
      // `VERITY_SANDBOX_MEMORY` would land in.
      [
        'a sealed value that moved',
        { env: drifted(owned(true).env!, 'DATABASE_URL', 'postgres://elsewhere') },
      ],
      [
        'a sealed secret whose file was rewritten',
        { env: drifted(owned(true).env!, 'TOKEN', 'rotated') },
      ],
    ])('calls %s environment drift', async (_label, overrides) => {
      expect(await classify({ ...owned(true), ...overrides })).toBe('environment');
    });

    it.each([
      // THE clause that keeps this comparison the boundary it was built to be.
      [
        'a variable neither sealed nor baked',
        { env: [...owned(true).env!, 'NODE_OPTIONS=--require /injected.js'] },
      ],
      // Only a VALUE may drift. A sealed name the container does not carry is a
      // Server running WITHOUT a variable the authority requires — the "running
      // on defaults" state — and there is no value of its own to preserve, so
      // nothing about it is recoverable by tolerating it.
      [
        'a sealed name the container lacks entirely',
        { env: owned(true).env!.filter((e) => !e.startsWith('TOKEN=')) },
      ],
      [
        'a baked variable the container overrides',
        { env: drifted(owned(true).env!, 'NODE_ENV', 'debug') },
      ],
      [
        'a deployment id naming another install',
        { env: drifted(owned(true).env!, 'VERITY_MANAGED_DEPLOYMENT_ID', 'another-install') },
      ],
      // Comparing by name means building a map, and a map hides exactly these two
      // shapes: an entry with no `=` vanishes, and a repeated name keeps only its
      // last value. A container this code created can have neither, so both are
      // refused rather than silently excluded from the comparison — otherwise an
      // injected entry could ride along behind a well-formed one.
      ['an entry that is not NAME=value', { env: [...owned(true).env!, 'INJECTED_FLAG'] }],
      [
        'a sealed name carried twice',
        { env: [...owned(true).env!, 'DATABASE_URL=postgres://second'] },
      ],
      ['a baked name carried twice', { env: [...owned(true).env!, 'NODE_ENV=production'] }],
      ['another image', { image: `ghcr.io/foreign@sha256:${'b'.repeat(64)}` }],
      ['another user', { user: '0:0' }],
      ['another supplementary group set', { groupAdd: ['999'] }],
      ['another network', { networkMode: 'host' }],
      ['a writable root filesystem expectation', { readOnlyRootfs: true }],
      ['another restart policy', { restartPolicy: 'always' }],
      ['no no-new-privileges', { securityOpt: [] }],
      ['another capability set', { capAdd: ['CHOWN', 'SYS_ADMIN'] }],
      ['a dropped mount', { mounts: owned(true).mounts!.slice(1) }],
      ['no init', { init: false }],
    ])('calls %s structural', async (_label, overrides) => {
      expect(await classify({ ...owned(true), ...overrides })).toBe('structural');
    });

    it('calls a sealed host ceiling that was weakened structural', async () => {
      const authoritative = sealed({
        memoryBytes: 4 * 1024 ** 3,
        memorySwapBytes: 4 * 1024 ** 3,
        nanoCpus: 4_000_000_000,
        pidsLimit: 512,
      });
      const desired = await containerSpec(authoritative);
      expect(
        describeManagedContainerMismatch(
          { ...owned(true), memoryBytes: 0, memorySwapBytes: 0, nanoCpus: 0, pidsLimit: 0 },
          desired,
          IMAGE_ENV,
          true,
          sealedHostLimitsMode(authoritative),
        ),
      ).toBe('structural');
    });

    it('keeps managedContainerMatchesSpec exactly the match verdict', async () => {
      // The wrapper is defined as `describe(...) === 'match'`, so a caller that
      // only wants a yes/no cannot drift away from the classification.
      const desired = await containerSpec(sealed());
      for (const inspect of [
        owned(true),
        { ...owned(true), env: drifted(owned(true).env!, 'DATABASE_URL', 'postgres://elsewhere') },
        { ...owned(true), user: '0:0' },
      ]) {
        expect(managedContainerMatchesSpec(inspect, desired, IMAGE_ENV, true)).toBe(
          describeManagedContainerMismatch(inspect, desired, IMAGE_ENV, true) === 'match',
        );
      }
    });
  });

  it('leaves a running Server on drifted environment alone, and reports it', async () => {
    // The whole point: it is already serving on that value, and the Updater
    // cannot improve that by refusing to exist. Reporting is what makes the
    // tolerance honest rather than silent.
    const client = docker({
      ...owned(true),
      env: drifted(owned(true).env!, 'DATABASE_URL', 'postgres://yesterday'),
    });
    await expect(
      reconcileManagedServer(runtimeOptions(await authority(), client)),
    ).resolves.toEqual({ containerId: 'existing', action: 'unchanged', drift: ['DATABASE_URL'] });
    expect(client.removeContainer).not.toHaveBeenCalled();
    expect(client.startContainer).not.toHaveBeenCalled();
    expect(client.createContainer).not.toHaveBeenCalled();
  });

  it('reports every drifting name, and never a value', async () => {
    const client = docker({
      ...owned(true),
      env: drifted(
        drifted(owned(true).env!, 'DATABASE_URL', 'postgres://yesterday'),
        'TOKEN',
        'rotated',
      ),
    });
    const result = await reconcileManagedServer(runtimeOptions(await authority(), client));
    expect(result.drift).toEqual(['DATABASE_URL', 'TOKEN']);
    expect(JSON.stringify(result)).not.toContain('yesterday');
    expect(JSON.stringify(result)).not.toContain('rotated');
  });

  it('recreates a STOPPED Server whose only mismatch is environment', async () => {
    // Without this a reboot turns every tolerated drift into no Server at all.
    // It grants no new authority: the environment used is byte-for-byte the one
    // the create-from-scratch path already uses.
    const client = docker({
      ...owned(false),
      env: drifted(owned(true).env!, 'DATABASE_URL', 'postgres://yesterday'),
    });
    await expect(
      reconcileManagedServer(runtimeOptions(await authority(), client)),
    ).resolves.toEqual({ containerId: 'created', action: 'created' });
    expect(client.removeContainer).toHaveBeenCalledWith('existing');
    const [spec] = client.createContainer.mock.calls[0] as [{ env?: string[] }];
    expect(spec.env).toEqual([
      'DATABASE_URL=postgres://db',
      'VERITY_MANAGED_DEPLOYMENT_ID=deployment-1',
      'TOKEN=secret',
    ]);
  });

  describe('a container that won a concurrent create', () => {
    /** `createContainer` loses the name race; the winner is `existing`. */
    const raced = (existing: ContainerInspect) => {
      const client = docker(existing);
      (client.listContainers as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: existing.id, imageId: 'sha256:image', names: [MANAGED_SERVER_NAME] },
        ]);
      client.createContainer.mockRejectedValueOnce(
        Object.assign(new Error('name conflict'), { kind: 'conflict' }),
      );
      return client;
    };

    it('refuses a stopped drifted winner rather than starting it', async () => {
      // The one case where drift is neither tolerated nor repaired. Replacing a
      // container that appeared while we were creating one is not ours to do —
      // that is what stops create and reuse calling each other forever — and
      // STARTING a stopped drifted Server is exactly what this change exists to
      // prevent. The refusal is transient: the next reconcile finds it as the
      // single named container and rebuilds it with full authority.
      const client = raced({
        ...owned(false),
        env: drifted(owned(true).env!, 'DATABASE_URL', 'postgres://yesterday'),
      });
      await expect(
        reconcileManagedServer(runtimeOptions(await authority(), client)),
      ).rejects.toThrow(/conflicts/);
      expect(client.startContainer).not.toHaveBeenCalled();
      expect(client.removeContainer).not.toHaveBeenCalled();
    });

    it('starts a stopped winner that matches', async () => {
      // The control: refusing every stopped winner would strand the race itself.
      const client = raced(owned(false));
      await expect(
        reconcileManagedServer(runtimeOptions(await authority(), client)),
      ).resolves.toEqual({ containerId: 'existing', action: 'started' });
      expect(client.startContainer).toHaveBeenCalledWith('existing');
    });

    it('tolerates a running drifted winner, as it would anywhere else', async () => {
      const client = raced({
        ...owned(true),
        env: drifted(owned(true).env!, 'DATABASE_URL', 'postgres://yesterday'),
      });
      await expect(
        reconcileManagedServer(runtimeOptions(await authority(), client)),
      ).resolves.toEqual({
        containerId: 'existing',
        action: 'unchanged',
        drift: ['DATABASE_URL'],
      });
    });
  });

  it.each([true, false])('refuses a structural mismatch whether running is %s', async (running) => {
    const client = docker({ ...owned(running), user: '0:0' });
    await expect(reconcileManagedServer(runtimeOptions(await authority(), client))).rejects.toThrow(
      /managed Server container conflicts with the sealed deployment spec/,
    );
    expect(client.removeContainer).not.toHaveBeenCalled();
    expect(client.createContainer).not.toHaveBeenCalled();
    expect(client.startContainer).not.toHaveBeenCalled();
  });

  it.each([true, false])('refuses an injected variable whether running is %s', async (running) => {
    const client = docker({
      ...owned(running),
      env: [...owned(true).env!, 'NODE_OPTIONS=--require /injected.js'],
    });
    await expect(reconcileManagedServer(runtimeOptions(await authority(), client))).rejects.toThrow(
      /conflicts/,
    );
    expect(client.removeContainer).not.toHaveBeenCalled();
  });

  it('refuses a running Server carrying another install deployment ID', async () => {
    // The labels still say this deployment, so ownership passes — but the
    // container was built for a different install and adopting it would put this
    // authority in charge of someone else's Server.
    const client = docker({
      ...owned(true),
      env: drifted(owned(true).env!, 'VERITY_MANAGED_DEPLOYMENT_ID', 'another-install'),
    });
    await expect(reconcileManagedServer(runtimeOptions(await authority(), client))).rejects.toThrow(
      /conflicts/,
    );
  });

  it('refuses a candidate mid-update whose activation identity differs', async () => {
    // Tolerance must not reach the cutover handshake: a standby naming another
    // operation would be started into an activation that never comes.
    const identity = { name: 'verity-managed-server-g7', operationId: 'op-current', generation: 7 };
    const client = docker(
      {
        ...owned(true),
        env: [
          ...owned(true).env!,
          'VERITY_CONTROL_PLANE_WAIT_FOR_ACTIVATION=1',
          'VERITY_UPDATE_ID=op-from-an-earlier-attempt',
          `VERITY_CONTROL_PLANE_HOLDER_ID=${identity.name}`,
        ],
      },
      identity.name,
    );
    await expect(
      reconcileManagedServer({ ...runtimeOptions(await authority(), client), identity }),
    ).rejects.toThrow(/conflicts/);
    expect(client.removeContainer).not.toHaveBeenCalled();
  });

  describe('an environment source this host can no longer resolve', () => {
    /** A seal naming a variable the Updater's environment does not supply — the
     *  shape a removed Compose variable or an unmounted secret leaves behind. */
    const unresolvable = () =>
      authority([
        { name: 'VERITY_SANDBOX_MEMORY', source: { kind: 'env', name: 'VERITY_SANDBOX_MEMORY' } },
      ]);

    it('is fatal when the running Server does not carry the variable either', async () => {
      // The boundary of the tolerance, and the case that makes it defensible.
      // Keeping a running Server on a lost source is an argument about a value it
      // ALREADY HAS. This container has no value for the name at all, so there is
      // nothing to preserve — it is simply a Server running without a variable the
      // authority says it must have, which is the "quietly running on defaults"
      // state the retired list exists to prevent. Tolerating it would bless that
      // state rather than recover from anything.
      const client = docker(owned(true));
      await expect(
        reconcileManagedServer(runtimeOptions(await unresolvable(), client)),
      ).rejects.toThrow(/source is missing: VERITY_SANDBOX_MEMORY/);
      expect(client.createContainer).not.toHaveBeenCalled();
      expect(client.removeContainer).not.toHaveBeenCalled();
    });

    it('is drift when the running Server still carries the value it was created with', async () => {
      // THE real shape of this failure, and the one an easier implementation gets
      // wrong. The Server was created while the source still resolved, so it
      // carries the old value; the Updater can no longer resolve it, so the spec
      // it builds does not mention the name at all. Judging the container against
      // that BUILT environment rather than against the SEALED names would call
      // the Server's own value an injected variable and refuse it — turning the
      // lost source straight back into the crash loop this change removes.
      const client = docker({
        ...owned(true),
        env: [...owned(true).env!, 'VERITY_SANDBOX_MEMORY=4g'],
      });
      await expect(
        reconcileManagedServer(runtimeOptions(await unresolvable(), client)),
      ).resolves.toEqual({
        containerId: 'existing',
        action: 'unchanged',
        drift: ['VERITY_SANDBOX_MEMORY'],
      });
      expect(client.removeContainer).not.toHaveBeenCalled();
      expect(client.createContainer).not.toHaveBeenCalled();
    });

    it('is fatal when that same Server is stopped rather than running', async () => {
      // Same container, nothing serving. There is no honest Server to produce
      // without the source, so this stays fatal rather than starting one that
      // silently lacks a variable the authority says it must have.
      const client = docker({
        ...owned(false),
        env: [...owned(true).env!, 'VERITY_SANDBOX_MEMORY=4g'],
      });
      await expect(
        reconcileManagedServer(runtimeOptions(await unresolvable(), client)),
      ).rejects.toThrow(/source is missing: VERITY_SANDBOX_MEMORY/);
      expect(client.removeContainer).not.toHaveBeenCalled();
      expect(client.startContainer).not.toHaveBeenCalled();
    });

    it('is fatal when there is no Server at all', async () => {
      const client = docker();
      await expect(
        reconcileManagedServer(runtimeOptions(await unresolvable(), client)),
      ).rejects.toThrow(/managed Server environment source is missing: VERITY_SANDBOX_MEMORY/);
      expect(client.createContainer).not.toHaveBeenCalled();
    });

    it('is fatal when the Server on the name is stopped', async () => {
      // Nothing is serving, so there is no running environment to preserve and no
      // honest way to build a replacement.
      const client = docker(owned(false));
      await expect(
        reconcileManagedServer(runtimeOptions(await unresolvable(), client)),
      ).rejects.toThrow(/source is missing/);
      expect(client.removeContainer).not.toHaveBeenCalled();
    });

    it('is fatal when the running container is foreign', async () => {
      const client = docker({ ...owned(true), labels: { [MANAGED_ROLE_LABEL]: 'server' } });
      await expect(
        reconcileManagedServer(runtimeOptions(await unresolvable(), client)),
      ).rejects.toThrow(/foreign/);
    });

    // Losing the environment must not lose the rest of the boundary. Only the
    // VALUES of sealed names become unknowable; everything else still comes off
    // the sealed spec, so this path refuses exactly what the ordinary one
    // refuses. Without these the fallback would adopt any running container
    // whose two ownership labels happened to match.
    it.each([
      ['another image', { image: `ghcr.io/foreign@sha256:${'b'.repeat(64)}` }],
      ['another user', { user: '0:0' }],
      ['another network', { networkMode: 'host' }],
      ['a dropped mount', { mounts: owned(true).mounts!.slice(1) }],
      ['no no-new-privileges', { securityOpt: [] }],
      ['no init', { init: false }],
      [
        'an injected variable',
        { env: [...owned(true).env!, 'NODE_OPTIONS=--require /injected.js'] },
      ],
      [
        'a baked variable the container overrides',
        {
          env: [...owned(true).env!.filter((e) => !e.startsWith('NODE_ENV=')), 'NODE_ENV=debug'],
        },
      ],
      [
        'a deployment ID naming another install',
        {
          env: [
            ...owned(true).env!.filter((e) => !e.startsWith('VERITY_MANAGED_DEPLOYMENT_ID=')),
            'VERITY_MANAGED_DEPLOYMENT_ID=another-install',
          ],
        },
      ],
      [
        'an update identity no operation claims',
        { env: [...owned(true).env!, 'VERITY_UPDATE_ID=op-from-somewhere-else'] },
      ],
    ])('is fatal when the running container also shows %s', async (_label, overrides) => {
      const client = docker({ ...owned(true), ...overrides });
      await expect(
        reconcileManagedServer(runtimeOptions(await unresolvable(), client)),
      ).rejects.toThrow(/conflicts/);
      expect(client.createContainer).not.toHaveBeenCalled();
      expect(client.removeContainer).not.toHaveBeenCalled();
    });

    it('reports a value that also moved, not just the source that failed', async () => {
      // Resolution does not stop at the first failure. Reporting only the missing
      // source would let a simultaneous `DATABASE_URL` change hide behind it,
      // which is the opposite of what the report is for.
      const client = docker({
        ...owned(true),
        env: [
          ...drifted(owned(true).env!, 'DATABASE_URL', 'postgres://yesterday'),
          'VERITY_SANDBOX_MEMORY=4g',
        ],
      });
      await expect(
        reconcileManagedServer(runtimeOptions(await unresolvable(), client)),
      ).resolves.toMatchObject({
        action: 'unchanged',
        drift: ['DATABASE_URL', 'VERITY_SANDBOX_MEMORY'],
      });
    });

    it('reports every unresolvable source, not only the first', async () => {
      const root = await authority([
        { name: 'VERITY_SANDBOX_MEMORY', source: { kind: 'env', name: 'VERITY_SANDBOX_MEMORY' } },
        { name: 'VERITY_SANDBOX_CPUS', source: { kind: 'env', name: 'VERITY_SANDBOX_CPUS' } },
      ]);
      const client = docker({
        ...owned(true),
        env: [...owned(true).env!, 'VERITY_SANDBOX_MEMORY=4g', 'VERITY_SANDBOX_CPUS=2'],
      });
      await expect(reconcileManagedServer(runtimeOptions(root, client))).resolves.toMatchObject({
        drift: ['VERITY_SANDBOX_CPUS', 'VERITY_SANDBOX_MEMORY'],
      });
    });

    it('is fatal when only some of the unresolvable names are carried', async () => {
      // Partial evidence is not evidence. One preserved value does not make the
      // other absent one safe, so the whole reconcile stays fatal.
      const root = await authority([
        { name: 'VERITY_SANDBOX_MEMORY', source: { kind: 'env', name: 'VERITY_SANDBOX_MEMORY' } },
        { name: 'VERITY_SANDBOX_CPUS', source: { kind: 'env', name: 'VERITY_SANDBOX_CPUS' } },
      ]);
      const client = docker({
        ...owned(true),
        env: [...owned(true).env!, 'VERITY_SANDBOX_MEMORY=4g'],
      });
      await expect(reconcileManagedServer(runtimeOptions(root, client))).rejects.toThrow(
        /source is missing: VERITY_SANDBOX_CPUS/,
      );
    });

    it('does not tolerate a corrupt spec or a foreign deployment ID', async () => {
      // Only an UNRESOLVABLE source is judged leniently. A value carrying a NUL is
      // garbage and a deployment id that disagrees with the authority is a
      // different install; both stay fatal even with a running Server present.
      const client = docker(owned(true));
      await expect(
        reconcileManagedServer({
          ...runtimeOptions(await authority(), client),
          readFile: async () => 'se\0cret',
        }),
      ).rejects.toThrow(/contains NUL/);
      await expect(
        reconcileManagedServer({
          ...runtimeOptions(await authority(), docker(owned(true))),
          environment: {
            DATABASE_URL: 'postgres://db',
            VERITY_MANAGED_DEPLOYMENT_ID: 'another-deployment',
          },
        }),
      ).rejects.toThrow(/deployment ID does not match/);
    });
  });
});
