import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DockerError, type ContainerInspect, type ContainerSpec } from '../docker.js';
import type { ServerDeploymentSpecBody } from './deployment-spec.js';
import {
  dockerUpdatePreparation,
  type UpdatePreparationDocker,
} from './docker-update-preparation.js';
import { initializeManagedDeployment } from './managed-deployment.js';
import type { UpdatePreparationDeps } from './update-preparation.js';
import { resumeUpdatePreparation } from './update-preparation.js';
import type { UpdateJournal } from './update-journal.js';
import { beginUpdate } from './update-journal.js';

/** The two candidate builders share every refusal below, so the cases that apply
 *  to both are written once and run against each. */
type PreparedActions = UpdatePreparationDeps;

const oldImage = `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`;
const newImage = `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`;

async function setup(options: { serverVersionSource?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'docker-update-preparation-'));
  const spec: Omit<ServerDeploymentSpecBody, 'schemaVersion' | 'deploymentId'> = {
    image: oldImage,
    environment: [
      { name: 'DATABASE_URL', source: { kind: 'env', name: 'DATABASE_URL' } },
      { name: 'VERITY_MANAGED_DEPLOYMENT_ID', source: { kind: 'env', name: 'DEPLOYMENT_ID' } },
      ...(options.serverVersionSource === true
        ? [
            {
              name: 'VERITY_SERVER_VERSION',
              source: { kind: 'env' as const, name: 'CURRENT_SERVER_VERSION' },
            },
          ]
        : []),
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
    user: { uid: 1000, gid: 1000, supplementaryGids: [999] },
    restart: 'unless-stopped',
    network: 'verity-net',
    platform: { os: 'linux', architecture: 'amd64' },
    security: { noNewPrivileges: true, readOnlyRootFilesystem: false, capAdd: [] },
  };
  await initializeManagedDeployment({ root, deploymentId: 'deployment-1', spec });
  const journal = await beginUpdate({
    root,
    deploymentId: 'deployment-1',
    idempotencyKey: 'request-1',
    previousDigest: oldImage,
    targetDigest: newImage,
    currentGeneration: 0,
  });
  return { root, journal };
}

// The candidate image's own baked environment. A real daemon reports a
// container's `Config.Env` as these with the create request applied on top, so
// the fixtures below merge rather than echo the spec.
const IMAGE_ENV = [
  'PATH=/usr/local/bin:/usr/bin:/bin',
  'NODE_ENV=production',
  'PORT=8082',
  'VERITY_ROOT=/srv/verity',
  'VERITY_SERVER_VERSION=11.1.0',
];

type FakeDocker = UpdatePreparationDocker & {
  listContainers: ReturnType<typeof vi.fn<NonNullable<UpdatePreparationDocker['listContainers']>>>;
  inspectContainer: ReturnType<typeof vi.fn<UpdatePreparationDocker['inspectContainer']>>;
  createContainer: ReturnType<typeof vi.fn<UpdatePreparationDocker['createContainer']>>;
  startContainer: ReturnType<typeof vi.fn<UpdatePreparationDocker['startContainer']>>;
  waitContainer: ReturnType<typeof vi.fn<NonNullable<UpdatePreparationDocker['waitContainer']>>>;
  containerLogs: ReturnType<typeof vi.fn<NonNullable<UpdatePreparationDocker['containerLogs']>>>;
  removeContainer: ReturnType<typeof vi.fn<UpdatePreparationDocker['removeContainer']>>;
  pullImage: ReturnType<typeof vi.fn<NonNullable<UpdatePreparationDocker['pullImage']>>>;
  inspectImageEnv: ReturnType<
    typeof vi.fn<NonNullable<UpdatePreparationDocker['inspectImageEnv']>>
  >;
  inspectImageLabels: ReturnType<
    typeof vi.fn<NonNullable<UpdatePreparationDocker['inspectImageLabels']>>
  >;
};

function fakeDocker(): FakeDocker {
  return {
    listContainers: vi.fn<NonNullable<UpdatePreparationDocker['listContainers']>>(async () => []),
    inspectContainer: vi.fn<UpdatePreparationDocker['inspectContainer']>(),
    createContainer: vi.fn(async () => ({ id: 'a'.repeat(64), warnings: [] })),
    startContainer: vi.fn(async () => undefined),
    waitContainer: vi.fn(async () => 0),
    containerLogs: vi.fn(async () => ''),
    removeContainer: vi.fn(async () => undefined),
    pullImage: vi.fn(async () => undefined),
    inspectImageEnv: vi.fn(async () => IMAGE_ENV),
    inspectImageLabels: vi.fn(async () => undefined),
  };
}

/** What the daemon would report for a container created from `spec`: the image's
 *  environment with the request applied on top, volume mounts carrying both the
 *  name and the host path the name resolves to, and the host ceilings the create
 *  request asked for. */
function inspectFromSpec(spec: ContainerSpec, status: string): ContainerInspect {
  const env = new Map<string, string>();
  for (const entry of [...IMAGE_ENV, ...(spec.env ?? [])])
    env.set(entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1));
  return {
    id: 'c'.repeat(64),
    running: status === 'running',
    status,
    image: spec.image,
    labels: spec.labels,
    user: spec.user,
    groupAdd: spec.groupAdd,
    networkMode: spec.network,
    readOnlyRootfs: spec.readOnlyRootfs,
    restartPolicy: spec.restartPolicy,
    securityOpt: spec.securityOpt,
    capAdd: spec.capAdd,
    env: [...env].map(([name, value]) => `${name}=${value}`),
    entrypoint: spec.entrypoint,
    command: spec.command,
    ...(spec.memoryBytes === undefined ? {} : { memoryBytes: spec.memoryBytes }),
    ...(spec.memorySwapBytes === undefined ? {} : { memorySwapBytes: spec.memorySwapBytes }),
    ...(spec.nanoCpus === undefined ? {} : { nanoCpus: spec.nanoCpus }),
    ...(spec.pidsLimit === undefined ? {} : { pidsLimit: spec.pidsLimit }),
    mounts: [
      ...(spec.binds ?? []).map((bind) => {
        const [source, destination, mode] = bind.split(':');
        return { type: 'bind', source, destination, readWrite: mode !== 'ro' };
      }),
      ...(spec.volumeMounts ?? []).map((mount) => ({
        type: 'volume',
        name: mount.volume,
        source: `/var/lib/docker/volumes/${mount.volume}/_data`,
        destination: mount.target,
        readWrite: mount.readOnly !== true,
      })),
    ],
    init: true,
  };
}

describe('Docker update preparation', () => {
  it('drives the durable journal through real Docker actions to a promotable standby', async () => {
    const { root } = await setup();
    const docker = fakeDocker();
    const verifyImage = vi.fn(async () => undefined);
    const actions = await dockerUpdatePreparation({
      managedRoot: root,
      docker,
      environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
      verifyImage,
    });
    await expect(resumeUpdatePreparation(root, actions)).resolves.toMatchObject({
      phase: 'standby',
      candidate: { containerId: 'a'.repeat(64), containerName: 'verity-managed-server-g1' },
    });
    expect(docker.pullImage).toHaveBeenCalledWith(newImage);
    expect(verifyImage).toHaveBeenCalledOnce();
    expect(docker.createContainer).toHaveBeenCalledTimes(2);
    expect(docker.startContainer).toHaveBeenCalledTimes(2);
  });

  /**
   * The PostgreSQL pre-pull (ADR 0008 D14).
   *
   * The database swap happens inside the cutover's maintenance window, and the
   * whole argument for putting it there is that it waits on nothing. That only
   * holds if the image is already on the daemon by the time the old Server
   * quiesces, which is here — while it is still serving.
   */
  describe('the bundled PostgreSQL image', () => {
    const postgres = `postgres:18-alpine@sha256:${'e'.repeat(64)}`;
    const prepare = async (docker: FakeDocker) => {
      const { root } = await setup();
      await resumeUpdatePreparation(
        root,
        await dockerUpdatePreparation({
          managedRoot: root,
          docker,
          environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
          verifyImage: async () => undefined,
        }),
      );
    };

    it('is pulled while the old Server is still serving', async () => {
      const docker = fakeDocker();
      docker.inspectImageLabels = vi.fn(async () => ({ 'org.verity.postgres-image': postgres }));
      await prepare(docker);
      expect(docker.inspectImageLabels).toHaveBeenCalledWith(newImage);
      expect(docker.pullImage.mock.calls.map(([ref]) => ref)).toEqual([newImage, postgres]);
    });

    it('is not pulled at all by a release that names none', async () => {
      const docker = fakeDocker();
      await prepare(docker);
      expect(docker.pullImage.mock.calls.map(([ref]) => ref)).toEqual([newImage]);
    });

    /** A registry that cannot serve a third-party image is not a reason to fail
     *  a Server update with nothing else wrong with it; the reconciler declines
     *  the swap when the image is missing and the database waits for next time. */
    it('does not fail preparation when its pull fails', async () => {
      const docker = fakeDocker();
      docker.inspectImageLabels = vi.fn(async () => ({ 'org.verity.postgres-image': postgres }));
      docker.pullImage = vi.fn(async (ref: string) => {
        if (ref === postgres) throw new Error('registry unreachable');
      });
      await expect(prepare(docker)).resolves.toBeUndefined();
    });

    it('still fails preparation when the SERVER image cannot be pulled', async () => {
      const docker = fakeDocker();
      docker.pullImage = vi.fn(async () => {
        throw new Error('registry unreachable');
      });
      const { root } = await setup();
      await expect(
        resumeUpdatePreparation(
          root,
          await dockerUpdatePreparation({
            managedRoot: root,
            docker,
            environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
            verifyImage: async () => undefined,
          }),
        ),
      ).rejects.toThrow('registry unreachable');
    });
  });

  it('runs the target preflight to completion and always removes it', async () => {
    const { root, journal } = await setup();
    const docker = fakeDocker();
    const actions = await dockerUpdatePreparation({
      managedRoot: root,
      docker,
      environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
      verifyImage: vi.fn(async () => undefined),
    });
    await actions.runPreflight(journal);
    expect(docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        image: newImage,
        name: 'verity-managed-preflight-g1',
        command: ['preflight'],
        restartPolicy: 'no',
        binds: [],
        readOnlyRootfs: true,
        env: ['DATABASE_URL=postgres://db', 'VERITY_PREFLIGHT_READ_ONLY=1'],
        volumeMounts: [{ volume: 'verity-data', target: '/srv/verity', readOnly: true }],
      }),
    );
    expect(docker.startContainer).toHaveBeenCalledWith('a'.repeat(64));
    expect(docker.waitContainer).toHaveBeenCalledWith('a'.repeat(64));
    expect(docker.removeContainer).toHaveBeenCalledWith('a'.repeat(64));
  });

  it('rejects a failed preflight and collects only bounded diagnostic logs', async () => {
    const { root, journal } = await setup();
    const docker = fakeDocker();
    docker.waitContainer.mockResolvedValue(7);
    const actions = await dockerUpdatePreparation({
      managedRoot: root,
      docker,
      environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
      verifyImage: vi.fn(async () => undefined),
    });
    await expect(actions.runPreflight(journal)).rejects.toThrow(/exit code 7/);
    expect(docker.containerLogs).toHaveBeenCalledWith('a'.repeat(64), 200);
    expect(docker.removeContainer).toHaveBeenCalledOnce();
  });

  it('recovers an exact preflight container after a create conflict', async () => {
    const { root, journal } = await setup();
    const docker = fakeDocker();
    let desired: ContainerSpec | undefined;
    docker.createContainer.mockImplementation(async (spec: ContainerSpec) => {
      desired = spec;
      throw new DockerError({ kind: 'conflict', message: spec.name });
    });
    docker.listContainers.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'c'.repeat(64),
        imageId: 'sha256:image',
        names: ['verity-managed-preflight-g1'],
      },
    ]);
    docker.inspectContainer.mockImplementation(async () => inspectFromSpec(desired!, 'created'));
    const actions = await dockerUpdatePreparation({
      managedRoot: root,
      docker,
      environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
      verifyImage: vi.fn(async () => undefined),
    });
    await expect(actions.runPreflight(journal)).resolves.toBeUndefined();
    expect(docker.startContainer).toHaveBeenCalledWith('c'.repeat(64));
    expect(docker.removeContainer).toHaveBeenCalledWith('c'.repeat(64));
  });

  it('starts a fully specified candidate that waits behind the activation fence', async () => {
    const { root, journal } = await setup();
    const docker = fakeDocker();
    const actions = await dockerUpdatePreparation({
      managedRoot: root,
      docker,
      environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
      verifyImage: vi.fn(async () => undefined),
    });
    await expect(actions.ensureStandby(journal)).resolves.toEqual({
      containerId: 'a'.repeat(64),
      containerName: 'verity-managed-server-g1',
    });
    expect(docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        image: newImage,
        name: 'verity-managed-server-g1',
        network: 'verity-net',
        env: expect.arrayContaining([
          'DATABASE_URL=postgres://db',
          'VERITY_CONTROL_PLANE_HOLDER_ID=verity-managed-server-g1',
          'VERITY_CONTROL_PLANE_WAIT_FOR_ACTIVATION=1',
          'VERITY_UPDATE_ID=generation-1',
        ]),
        volumeMounts: expect.arrayContaining([
          { volume: 'verity-data', target: '/srv/verity', readOnly: false },
        ]),
      }),
    );
    expect(docker.createContainer.mock.calls[0]?.[0]).not.toHaveProperty('portBindings');
    expect(docker.startContainer).toHaveBeenCalledWith('a'.repeat(64));
  });

  it('inherits the target image version instead of the outgoing Server version', async () => {
    const { root, journal } = await setup({ serverVersionSource: true });
    const docker = fakeDocker();
    const actions = await dockerUpdatePreparation({
      managedRoot: root,
      docker,
      environment: {
        DATABASE_URL: 'postgres://db',
        DEPLOYMENT_ID: 'deployment-1',
        CURRENT_SERVER_VERSION: '11.0.0',
      },
      verifyImage: vi.fn(async () => undefined),
    });

    await actions.ensureStandby(journal);

    const candidate = docker.createContainer.mock.calls[0]![0];
    expect(candidate.env).not.toContain('VERITY_SERVER_VERSION=11.0.0');
    expect(candidate.env).toContain('VERITY_SERVER_VERSION=11.1.0');
    expect(inspectFromSpec(candidate, 'running').env).toContain('VERITY_SERVER_VERSION=11.1.0');
  });

  it('refuses to create a standby whose target image has no version identity', async () => {
    const { root, journal } = await setup({ serverVersionSource: true });
    const docker = fakeDocker();
    docker.inspectImageEnv.mockResolvedValue(
      IMAGE_ENV.filter((entry) => !entry.startsWith('VERITY_SERVER_VERSION=')),
    );
    const actions = await dockerUpdatePreparation({
      managedRoot: root,
      docker,
      environment: {
        DATABASE_URL: 'postgres://db',
        DEPLOYMENT_ID: 'deployment-1',
        CURRENT_SERVER_VERSION: '11.0.0',
      },
      verifyImage: vi.fn(async () => undefined),
    });

    await expect(actions.ensureStandby(journal)).rejects.toThrow(
      'target Server image does not declare its version',
    );
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it('starts an exact standby left in created state by a crashed updater', async () => {
    const { root, journal } = await setup();
    const first = fakeDocker();
    const options = {
      managedRoot: root,
      environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
      verifyImage: vi.fn(async () => undefined),
    };
    const initial = await dockerUpdatePreparation({ ...options, docker: first });
    await initial.ensureStandby(journal);
    const desired = first.createContainer.mock.calls[0]![0];
    const resumed = fakeDocker();
    resumed.listContainers.mockResolvedValue([
      {
        id: 'c'.repeat(64),
        imageId: 'sha256:image',
        names: ['verity-managed-server-g1'],
      },
    ]);
    resumed.inspectContainer.mockResolvedValue(inspectFromSpec(desired, 'created'));
    const actions = await dockerUpdatePreparation({ ...options, docker: resumed });
    await expect(actions.ensureStandby(journal)).resolves.toMatchObject({
      containerId: 'c'.repeat(64),
    });
    expect(resumed.startContainer).toHaveBeenCalledWith('c'.repeat(64));
    expect(resumed.createContainer).not.toHaveBeenCalled();
  });

  it('refuses a standby that carries no host resource ceilings', async () => {
    const { root, journal } = await setup();
    const first = fakeDocker();
    const options = {
      managedRoot: root,
      environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
      verifyImage: vi.fn(async () => undefined),
    };
    const initial = await dockerUpdatePreparation({ ...options, docker: first });
    await initial.ensureStandby(journal);
    const desired = first.createContainer.mock.calls[0]![0];
    const resumed = fakeDocker();
    resumed.listContainers.mockResolvedValue([
      { id: 'c'.repeat(64), imageId: 'sha256:image', names: ['verity-managed-server-g1'] },
    ]);
    // Right labels, right image, right environment — but created without the
    // ceilings, the way an Updater from before they existed would have made it.
    // Adopting it would promote an unbounded control plane.
    resumed.inspectContainer.mockResolvedValue({
      ...inspectFromSpec(desired, 'created'),
      memoryBytes: 0,
      memorySwapBytes: 0,
      nanoCpus: 0,
      pidsLimit: 0,
    });
    const actions = await dockerUpdatePreparation({ ...options, docker: resumed });
    await expect(actions.ensureStandby(journal)).rejects.toThrow(
      /reserved standby name is occupied by a conflicting container/,
    );
    expect(resumed.startContainer).not.toHaveBeenCalled();
  });

  it('refuses to prepare an update without managed Server authority', async () => {
    // Every action below is derived from the sealed spec — image, mounts, user,
    // network. Without it there is nothing to build a candidate from, and this is
    // the only place that can say so before any container exists.
    const root = await mkdtemp(join(tmpdir(), 'docker-update-preparation-unmanaged-'));

    await expect(
      dockerUpdatePreparation({
        managedRoot: root,
        docker: fakeDocker(),
        environment: {},
        verifyImage: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow(
      'managed Server authority unavailable: managed deployment has not been initialized',
    );
  });

  it('refuses a journal that authorizes a different deployment', async () => {
    // The journal names the digest to be verified and installed. Accepting one
    // written for another deployment would let a neighbouring deployment's signed
    // release be promoted into this one.
    const { root, journal } = await setup();
    const verifyImage = vi.fn(async () => undefined);
    const actions = await dockerUpdatePreparation({
      managedRoot: root,
      docker: fakeDocker(),
      environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
      verifyImage,
    });

    await expect(actions.verifyImage({ ...journal, deploymentId: 'deployment-2' })).rejects.toThrow(
      'update journal deployment does not match managed authority',
    );
    // The signature check is never even reached, so a valid signature over the
    // wrong deployment's release cannot stand in for authority.
    expect(verifyImage).not.toHaveBeenCalled();
  });

  it('refuses to prepare a standby whose reserved name is claimed twice', async () => {
    // Docker cannot produce two containers under one name, so this means another
    // manager is on the daemon. Adopting either one would leave the update
    // pointing at a container something else is free to replace.
    const { root, journal } = await setup();
    const docker = fakeDocker();
    docker.listContainers.mockResolvedValue([
      { id: 'c'.repeat(64), imageId: 'sha256:one', names: ['verity-managed-server-g1'] },
      { id: 'd'.repeat(64), imageId: 'sha256:two', names: ['verity-managed-server-g1'] },
    ]);
    const actions = await dockerUpdatePreparation({
      managedRoot: root,
      docker,
      environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
      verifyImage: vi.fn(async () => undefined),
    });

    await expect(actions.ensureStandby(journal)).rejects.toThrow(
      'multiple containers use reserved update name: verity-managed-server-g1',
    );
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it('refuses to prepare a standby on a daemon that stopped listing containers', async () => {
    // The capability is checked once when the actions are built, but every
    // adoption decision below depends on the listing being there at call time.
    // Guessing "no container by that name" from a missing listing would create a
    // second standby beside one that already exists.
    const { root, journal } = await setup();
    const docker = fakeDocker();
    const actions = await dockerUpdatePreparation({
      managedRoot: root,
      docker,
      environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
      verifyImage: vi.fn(async () => undefined),
    });
    docker.listContainers = undefined as never;

    await expect(actions.ensureStandby(journal)).rejects.toThrow(
      'update preparation requires container listing',
    );
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it.each([
    [
      'standby',
      'verity-managed-server-g1',
      (actions: PreparedActions, j: UpdateJournal) => actions.ensureStandby(j),
    ],
    [
      'preflight',
      'verity-managed-preflight-g1',
      (actions: PreparedActions, j: UpdateJournal) => actions.runPreflight(j),
    ],
  ])('surfaces a %s create failure that is not a name conflict', async (_role, _name, run) => {
    const { root, journal } = await setup();
    const docker = fakeDocker();
    docker.createContainer.mockRejectedValue(
      new DockerError({ kind: 'other', status: 500, message: 'daemon out of disk' }),
    );
    const actions = await dockerUpdatePreparation({
      managedRoot: root,
      docker,
      environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
      verifyImage: vi.fn(async () => undefined),
    });

    // Not reinterpreted as a conflict: a daemon that could not create the
    // container has no winner to adopt, and looking for one would report the
    // wrong cause for the failed update.
    await expect(run(actions, journal)).rejects.toThrow('daemon out of disk');
  });

  it.each([
    ['standby', (actions: PreparedActions, j: UpdateJournal) => actions.ensureStandby(j)],
    ['preflight', (actions: PreparedActions, j: UpdateJournal) => actions.runPreflight(j)],
  ])('refuses a %s create conflict that no container owns', async (role, run) => {
    // A conflict says the name is taken; an empty listing says it is not. The two
    // cannot both be true, so something is removing containers underneath this
    // operation and it must not resume against a name it cannot resolve.
    const { root, journal } = await setup();
    const docker = fakeDocker();
    const conflict = new DockerError({ kind: 'conflict', message: 'name already in use' });
    docker.createContainer.mockRejectedValue(conflict);
    const actions = await dockerUpdatePreparation({
      managedRoot: root,
      docker,
      environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
      verifyImage: vi.fn(async () => undefined),
    });

    const failure: unknown = await run(actions, journal).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(`${role} create conflict has no unique owner`);
    // The daemon's own conflict is kept as the cause: without it the operator is
    // told a name is contested with nothing saying which call reported it.
    expect((failure as Error).cause).toBe(conflict);
  });

  it.each([
    [
      'standby',
      'verity-managed-server-g1',
      (actions: PreparedActions, j: UpdateJournal) => actions.ensureStandby(j),
    ],
    [
      'preflight',
      'verity-managed-preflight-g1',
      (actions: PreparedActions, j: UpdateJournal) => actions.runPreflight(j),
    ],
  ])('refuses to adopt a %s create conflict won by another operation', async (role, name, run) => {
    // Same name, same generation — but a different update id, so it was created
    // by an operation this one knows nothing about. Adopting it would promote a
    // container built from somebody else's journal.
    const { root, journal } = await setup();
    const docker = fakeDocker();
    let desired: ContainerSpec | undefined;
    docker.createContainer.mockImplementation(async (spec: ContainerSpec) => {
      desired = spec;
      throw new DockerError({ kind: 'conflict', message: spec.name });
    });
    docker.listContainers
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: 'c'.repeat(64), imageId: 'sha256:image', names: [name] }]);
    docker.inspectContainer.mockImplementation(async () => ({
      ...inspectFromSpec(desired!, 'created'),
      labels: { ...desired!.labels, 'verity.update-id': 'somebody-elses-update' },
    }));
    const actions = await dockerUpdatePreparation({
      managedRoot: root,
      docker,
      environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
      verifyImage: vi.fn(async () => undefined),
    });

    await expect(run(actions, journal)).rejects.toThrow(
      `${role} create conflict belongs to another operation`,
    );
    expect(docker.startContainer).not.toHaveBeenCalled();
  });

  it('adopts and starts the exact standby that won a create conflict', async () => {
    const { root, journal } = await setup();
    const docker = fakeDocker();
    let desired: ContainerSpec | undefined;
    docker.createContainer.mockImplementation(async (spec: ContainerSpec) => {
      desired = spec;
      throw new DockerError({ kind: 'conflict', message: spec.name });
    });
    docker.listContainers
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { id: 'c'.repeat(64), imageId: 'sha256:image', names: ['verity-managed-server-g1'] },
      ]);
    docker.inspectContainer.mockImplementation(async () => inspectFromSpec(desired!, 'created'));
    const actions = await dockerUpdatePreparation({
      managedRoot: root,
      docker,
      environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
      verifyImage: vi.fn(async () => undefined),
    });

    await expect(actions.ensureStandby(journal)).resolves.toEqual({
      containerId: 'c'.repeat(64),
      containerName: 'verity-managed-server-g1',
    });
    // Created but not started is exactly the state a crash between the two leaves,
    // and a standby that is never started never reaches the activation fence.
    expect(docker.startContainer).toHaveBeenCalledWith('c'.repeat(64));
  });

  it('waits on an exact preflight a crashed updater already ran', async () => {
    // Preflight is the read-only proof the target image can serve this database.
    // Re-running it is safe but slow; what must not happen is treating an already
    // exited run as unfinished and starting it a second time.
    const { root, journal } = await setup();
    const first = fakeDocker();
    const options = {
      managedRoot: root,
      environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
      verifyImage: vi.fn(async () => undefined),
    };
    const initial = await dockerUpdatePreparation({ ...options, docker: first });
    await initial.runPreflight(journal);
    const desired = first.createContainer.mock.calls[0]![0];

    const resumed = fakeDocker();
    resumed.listContainers.mockResolvedValue([
      { id: 'c'.repeat(64), imageId: 'sha256:image', names: ['verity-managed-preflight-g1'] },
    ]);
    resumed.inspectContainer.mockResolvedValue(inspectFromSpec(desired, 'exited'));
    const actions = await dockerUpdatePreparation({ ...options, docker: resumed });

    await expect(actions.runPreflight(journal)).resolves.toBeUndefined();
    expect(resumed.createContainer).not.toHaveBeenCalled();
    expect(resumed.startContainer).not.toHaveBeenCalled();
    expect(resumed.waitContainer).toHaveBeenCalledWith('c'.repeat(64));
    expect(resumed.removeContainer).toHaveBeenCalledWith('c'.repeat(64));
  });

  it.each([
    [
      'was created by another operation',
      (inspect: ContainerInspect, desired: ContainerSpec): ContainerInspect => ({
        ...inspect,
        labels: { ...desired.labels, 'verity.update-id': 'somebody-elses-update' },
      }),
    ],
    [
      'is still running the outgoing image',
      (inspect: ContainerInspect): ContainerInspect => ({ ...inspect, image: oldImage }),
    ],
  ])('refuses a reserved preflight name held by a container that %s', async (_case, corrupt) => {
    // The preflight container is removed unconditionally when this returns, so
    // adopting somebody else's container under that name would delete it.
    const { root, journal } = await setup();
    const first = fakeDocker();
    const options = {
      managedRoot: root,
      environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
      verifyImage: vi.fn(async () => undefined),
    };
    const initial = await dockerUpdatePreparation({ ...options, docker: first });
    await initial.runPreflight(journal);
    const desired = first.createContainer.mock.calls[0]![0];

    const resumed = fakeDocker();
    resumed.listContainers.mockResolvedValue([
      { id: 'c'.repeat(64), imageId: 'sha256:image', names: ['verity-managed-preflight-g1'] },
    ]);
    resumed.inspectContainer.mockResolvedValue(
      corrupt(inspectFromSpec(desired, 'exited'), desired),
    );
    const actions = await dockerUpdatePreparation({ ...options, docker: resumed });

    await expect(actions.runPreflight(journal)).rejects.toThrow(
      'reserved preflight name is occupied by a conflicting container',
    );
    expect(resumed.removeContainer).not.toHaveBeenCalled();
  });

  it('refuses to build the standby template once the authority has gone away', async () => {
    // `prepareStandby` re-reads the sealed spec so the standby is the first Server
    // built from the migrated one. If the authority cannot be read at that moment
    // the operation must stop, not fall back to the template it captured earlier.
    const { root, journal } = await setup();
    const actions = await dockerUpdatePreparation({
      managedRoot: root,
      docker: fakeDocker(),
      environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
      verifyImage: vi.fn(async () => undefined),
    });
    await rm(join(root, 'server-deployment.json'));

    await expect(actions.prepareStandby!(journal)).rejects.toThrow(
      /^managed Server authority unavailable: /,
    );
  });
});
