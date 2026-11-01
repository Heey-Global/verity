import { execFileSync } from 'node:child_process';
import { DEVCONTAINER_BUILDER_CONTRACT } from './devcontainer-builder.js';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DockerError, type ContainerInspect, type ContainerSpec } from '../docker.js';
import type { ServerDeploymentSpecBody } from './deployment-spec.js';
import {
  dockerUpdatePreparation,
  type UpdatePreparationDocker,
} from './docker-update-preparation.js';
import {
  initializeManagedDeployment,
  migrateManagedHostDiagnostics,
  readManagedDeployment,
} from './managed-deployment.js';
import type { UpdatePreparationDeps } from './update-preparation.js';
import { resumeUpdatePreparation } from './update-preparation.js';
import type { UpdateJournal } from './update-journal.js';
import { advanceUpdate, beginUpdate, readUpdateJournal } from './update-journal.js';
import { UPDATE_PULL_RETRY_DELAYS_MS } from './pull-retry.js';

/** The two candidate builders share every refusal below, so the cases that apply
 *  to both are written once and run against each. */
type PreparedActions = UpdatePreparationDeps;

const oldImage = `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`;
const newImage = `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`;

async function setup(options: { serverVersionSource?: boolean; pairing?: boolean } = {}) {
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
      ...(options.pairing
        ? [
            {
              source: { kind: 'bind' as const, path: '/etc/verity' },
              target: '/run/verity-pairing',
              readOnly: true,
            },
          ]
        : []),
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
    capDrop: spec.capDrop,
    runtime: spec.runtime,
    pidMode: spec.pidMode,
    tmpfs: spec.tmpfs,
    privileged: false,
    deviceCount: 0,
    env: [...env].map(([name, value]) => `${name}=${value}`),
    entrypoint: spec.entrypoint,
    command: spec.command,
    ...(spec.memoryBytes === undefined ? {} : { memoryBytes: spec.memoryBytes }),
    ...(spec.memorySwapBytes === undefined ? {} : { memorySwapBytes: spec.memorySwapBytes }),
    ...(spec.oomScoreAdj === undefined ? {} : { oomScoreAdj: spec.oomScoreAdj }),
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
  it('preserves an existing sealed diagnostic path when the exporter path changes', async () => {
    const { root, journal } = await setup();
    await migrateManagedHostDiagnostics({
      root,
      deploymentId: 'deployment-1',
      image: oldImage,
      hostPath: '/sealed/host-diagnostics',
    });
    const hostRuntimeDir = await mkdtemp(join(tmpdir(), 'host-diagnostic-relocated-'));
    const docker = fakeDocker();
    const log = vi.fn();
    const now = new Date().toISOString();
    try {
      await writeFile(
        join(hostRuntimeDir, 'diagnostics.json'),
        JSON.stringify({
          version: 1,
          hostPath: '/relocated/host-diagnostics',
          snapshot: {
            schemaVersion: 1,
            observedAt: now,
            since: now,
            until: now,
            sources: { kernel: 'available', runtime: 'available' },
            truncated: false,
          },
        }),
      );
      const actions = await dockerUpdatePreparation({
        managedRoot: root,
        docker,
        environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
        verifyImage: async () => undefined,
        hostRuntimeDir,
        log,
      });
      await actions.prepareStandby!(journal);
      await actions.ensureStandby(journal);
      expect(docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          binds: expect.arrayContaining([
            '/sealed/host-diagnostics:/run/verity-host-diagnostics:ro',
          ]),
        }),
      );
      expect(log).toHaveBeenCalledWith(expect.stringContaining('retaining the existing mount'));
    } finally {
      await rm(hostRuntimeDir, { recursive: true, force: true });
    }
  });
  it.each(['unsupported', 'invalid', 'stale'] as const)(
    'defers the diagnostic bind for %s host evidence without blocking standby creation',
    async (state) => {
      const { root, journal } = await setup();
      const hostRuntimeDir = await mkdtemp(join(tmpdir(), 'host-diagnostic-unavailable-'));
      const docker = fakeDocker();
      const log = vi.fn();
      try {
        if (state !== 'unsupported') {
          const old = new Date(Date.now() - 600_000).toISOString();
          await writeFile(
            join(hostRuntimeDir, 'diagnostics.json'),
            state === 'invalid'
              ? '{'
              : JSON.stringify({
                  version: 1,
                  hostPath: '/var/lib/verity/host-diagnostics',
                  snapshot: {
                    schemaVersion: 1,
                    observedAt: old,
                    since: old,
                    until: old,
                    sources: { kernel: 'available', runtime: 'available' },
                    truncated: false,
                  },
                }),
          );
        }
        const actions = await dockerUpdatePreparation({
          managedRoot: root,
          docker,
          environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
          verifyImage: async () => undefined,
          hostRuntimeDir,
          log,
        });
        await actions.prepareStandby!(journal);
        await actions.ensureStandby(journal);
        expect(log).toHaveBeenCalledWith(expect.stringContaining(`Host diagnostics ${state}`));
        const deployment = await readManagedDeployment(root);
        if (!deployment.managed) throw new Error(deployment.reason);
        expect(
          deployment.spec.mounts.some((mount) => mount.target === '/run/verity-host-diagnostics'),
        ).toBe(false);
      } finally {
        await rm(hostRuntimeDir, { recursive: true, force: true });
      }
    },
  );
  it('migrates an exported custom path on retry and builds the standby with the read-only bind', async () => {
    const { root, journal } = await setup();
    const hostRuntimeDir = await mkdtemp(join(tmpdir(), 'host-diagnostic-preparation-'));
    const docker = fakeDocker();
    const now = new Date().toISOString();
    try {
      await writeFile(
        join(hostRuntimeDir, 'diagnostics.json'),
        JSON.stringify({
          version: 1,
          hostPath: '/custom/host-diagnostics',
          snapshot: {
            schemaVersion: 1,
            observedAt: now,
            since: now,
            until: now,
            sources: { kernel: 'available', runtime: 'available' },
            truncated: false,
          },
        }),
      );
      const actions = await dockerUpdatePreparation({
        managedRoot: root,
        docker,
        environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
        verifyImage: async () => undefined,
        hostRuntimeDir,
      });
      await actions.prepareStandby!(journal);
      const migrated = await readManagedDeployment(root);
      await actions.prepareStandby!(journal);
      expect(await readManagedDeployment(root)).toEqual(migrated);
      await actions.ensureStandby(journal);
      expect(docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          binds: expect.arrayContaining([
            '/custom/host-diagnostics:/run/verity-host-diagnostics:ro',
          ]),
        }),
      );
    } finally {
      await rm(hostRuntimeDir, { recursive: true, force: true });
    }
  });
  // An update is the guarded replacement that actually applies the builder bind,
  // so a host repaired while its old Server kept serving gets builds back with
  // its next update rather than needing a second repair.
  it.each([
    ['a verified builder receipt', { version: 1, gid: 1102 }, true],
    ['no receipt', undefined, false],
    ['a malformed receipt', { version: 1, gid: 0 }, false],
  ])('builds the standby with the builder socket only for %s', async (_, receipt, expected) => {
    const { root, journal } = await setup();
    const hostRuntimeDir = await mkdtemp(join(tmpdir(), 'devcontainer-builder-preparation-'));
    const docker = fakeDocker();
    try {
      if (receipt !== undefined)
        await writeFile(join(hostRuntimeDir, 'devcontainer-builder.json'), JSON.stringify(receipt));
      const actions = await dockerUpdatePreparation({
        managedRoot: root,
        docker,
        environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
        verifyImage: async () => undefined,
        hostRuntimeDir,
        log: () => undefined,
      });
      await actions.prepareStandby!(journal);
      await actions.ensureStandby(journal);
      const created = docker.createContainer.mock.calls.at(-1)?.[0] as ContainerSpec;
      expect(created.binds?.includes('/run/verity-buildkit:/run/verity-buildkit')).toBe(expected);
      expect(created.groupAdd?.includes('1102')).toBe(expected);
    } finally {
      await rm(hostRuntimeDir, { recursive: true, force: true });
    }
  });

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
    // The pull narrates its progress through the Updater's own log.
    expect(docker.pullImage).toHaveBeenCalledWith(newImage, { log: expect.any(Function) });
    expect(verifyImage).toHaveBeenCalledOnce();
    expect(docker.createContainer).toHaveBeenCalledTimes(2);
    expect(docker.startContainer).toHaveBeenCalledTimes(2);
  });

  /**
   * The host runtimes a release declares (ADR 0008 Amendment 2), read off the label every build
   * of deploy/Dockerfile carries. Without this wiring the reconciliation exists and is tested, and
   * a release needing `runsc-project` still activates on a host that only has `runsc`.
   */
  describe('the host runtimes the target release declares', () => {
    const label = /^LABEL (org\.verity\.host-runtimes)="(.*)"$/mu.exec(
      readFileSync('deploy/Dockerfile', 'utf8'),
    )!;
    const declared = JSON.parse(label[2]!.replaceAll('\\"', '"')) as {
      release: string;
      runtimes: Record<string, string[]>;
    };
    const registered = (names: string[]) =>
      vi.fn(async (name: string) =>
        names.includes(name)
          ? {
              path: `/opt/verity/runsc/${declared.release}/runsc`,
              args: [...declared.runtimes[name]!],
            }
          : undefined,
      );
    const prepare = async (
      docker: FakeDocker & { inspectRuntime: ReturnType<typeof registered> },
    ) => {
      const { root } = await setup();
      const hostRuntimeDir = await mkdtemp(join(tmpdir(), 'verity-host-runtime-'));
      try {
        docker.inspectImageLabels = vi.fn(async () => ({
          [label[1]!]: label[2]!.replaceAll('\\"', '"'),
        }));
        return await resumeUpdatePreparation(
          root,
          await dockerUpdatePreparation({
            managedRoot: root,
            docker,
            environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
            verifyImage: async () => undefined,
            hostRuntimeDir,
          }),
        );
      } finally {
        await rm(hostRuntimeDir, { recursive: true, force: true });
      }
    };

    it('creates no standby on a host that lacks one of them', async () => {
      const docker = { ...fakeDocker(), inspectRuntime: registered(['runsc']) };
      await expect(prepare(docker)).rejects.toThrow(/runsc-project.*the Verity installer/su);
      expect(docker.inspectImageLabels).toHaveBeenCalledWith(newImage);
      // Only the preflight container; the standby is never created.
      expect(docker.createContainer).toHaveBeenCalledTimes(1);
    });

    it('prepares the standby on a host that already has them', async () => {
      const docker = { ...fakeDocker(), inspectRuntime: registered(['runsc', 'runsc-project']) };
      await expect(prepare(docker)).resolves.toMatchObject({ phase: 'standby' });
      expect(docker.createContainer).toHaveBeenCalledTimes(2);
    });
  });

  // A host whose runtime service predates archive pins reaches an archive release through the
  // builder: the target's bundle registers the runtimes, so no runtime request is needed.
  it('installs an archive release through the builder on a host whose runtime service predates it', async () => {
    const { root } = await setup();
    const hostRuntimeDir = await mkdtemp(join(tmpdir(), 'verity-host-archive-'));
    const release = 'release-20261026.0';
    const args = {
      runsc: ['--platform=systrap', '--network=none'],
      'runsc-project': ['--platform=systrap', '--network=sandbox', '--host-uds=create'],
    } as Record<string, string[]>;
    const runtimes = new Map<string, { path: string; args: string[] }>();
    const docker = {
      ...fakeDocker(),
      inspectRuntime: vi.fn(async (name: string) => runtimes.get(name)),
    };
    const builderRequests: string[] = [];
    const host = setInterval(() => {
      void readFile(join(hostRuntimeDir, 'builder-request.json'), 'utf8').then(
        async (body) => {
          const { id } = JSON.parse(body) as { id: string };
          if (builderRequests.includes(id)) return;
          builderRequests.push(id);
          for (const name of Object.keys(args))
            runtimes.set(name, { path: `/opt/verity/runsc/${release}/runsc`, args: args[name]! });
          await writeFile(
            join(hostRuntimeDir, 'builder-result.json'),
            JSON.stringify({ version: 1, id, ok: true, message: 'builder updated' }),
          );
        },
        () => undefined,
      );
    }, 5);
    try {
      await writeFile(
        join(hostRuntimeDir, 'devcontainer-builder.json'),
        '{"version":1,"gid":1102}',
      );
      await writeFile(
        join(hostRuntimeDir, 'agent.json'),
        JSON.stringify({ version: 1, trigger: 'systemd-path', builder: 'systemd-path' }),
      );
      docker.inspectImageLabels = vi.fn(async () => ({
        'org.verity.devcontainer-builder': DEVCONTAINER_BUILDER_CONTRACT,
        'org.verity.host-runtimes': JSON.stringify({
          release,
          sha512: { x86_64: 'a'.repeat(128), aarch64: 'b'.repeat(128) },
          archiveSha512: { x86_64: 'c'.repeat(128), aarch64: 'd'.repeat(128) },
          runtimes: args,
        }),
      }));
      await expect(
        resumeUpdatePreparation(
          root,
          await dockerUpdatePreparation({
            managedRoot: root,
            docker,
            environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
            verifyImage: async () => undefined,
            hostRuntimeDir,
          }),
        ),
      ).resolves.toMatchObject({ phase: 'standby' });
      // One builder installation, reused by the regular builder step after the runtimes.
      expect(builderRequests).toHaveLength(1);
      await expect(readFile(join(hostRuntimeDir, 'request.json'))).rejects.toThrow(/ENOENT/u);
    } finally {
      clearInterval(host);
      await rm(hostRuntimeDir, { recursive: true, force: true });
    }
  });

  // Repository builds are not a reason to hold back a Server update: a builder the host cannot
  // update keeps the previous one, and the operator is told why instead of the update failing.
  it('prepares the standby when asking for the builder fails outright', async () => {
    const { root } = await setup();
    const hostRuntimeDir = await mkdtemp(join(tmpdir(), 'verity-host-builder-'));
    const docker = fakeDocker();
    const log = vi.fn();
    try {
      await writeFile(
        join(hostRuntimeDir, 'devcontainer-builder.json'),
        '{"version":1,"gid":1102}',
      );
      await writeFile(
        join(hostRuntimeDir, 'agent.json'),
        JSON.stringify({ version: 1, trigger: 'systemd-path', builder: 'systemd-path' }),
      );
      // The request cannot be written at all: an error, not a host answer.
      await mkdir(join(hostRuntimeDir, 'builder-request.json'));
      docker.inspectImageLabels = vi.fn(async () => ({
        'org.verity.devcontainer-builder': DEVCONTAINER_BUILDER_CONTRACT,
      }));
      await expect(
        resumeUpdatePreparation(
          root,
          await dockerUpdatePreparation({
            managedRoot: root,
            docker,
            environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
            verifyImage: async () => undefined,
            hostRuntimeDir,
            log,
          }),
        ),
      ).resolves.toMatchObject({ phase: 'standby' });
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/Devcontainer builder not updated/u));
    } finally {
      await rm(hostRuntimeDir, { recursive: true, force: true });
    }
  });

  it('logs a failed builder refresh separately from the archive runtime error', async () => {
    const { root } = await setup();
    const hostRuntimeDir = await mkdtemp(join(tmpdir(), 'verity-host-builder-'));
    const docker = { ...fakeDocker(), inspectRuntime: vi.fn(async () => undefined) };
    const log = vi.fn();
    try {
      await writeFile(
        join(hostRuntimeDir, 'devcontainer-builder.json'),
        '{"version":1,"gid":1102}',
      );
      await writeFile(
        join(hostRuntimeDir, 'agent.json'),
        JSON.stringify({ version: 1, trigger: 'systemd-path', builder: 'systemd-path' }),
      );
      // The request cannot be written at all: an error, not a host answer.
      await mkdir(join(hostRuntimeDir, 'builder-request.json'));
      docker.inspectImageLabels = vi.fn(async () => ({
        'org.verity.devcontainer-builder': DEVCONTAINER_BUILDER_CONTRACT,
        'org.verity.host-runtimes': JSON.stringify({
          release: 'release-20261026.0',
          sha512: { x86_64: 'a'.repeat(128), aarch64: 'b'.repeat(128) },
          archiveSha512: { x86_64: 'c'.repeat(128), aarch64: 'd'.repeat(128) },
          runtimes: {
            runsc: ['--platform=systrap', '--network=none'],
            'runsc-project': ['--platform=systrap', '--network=sandbox', '--host-uds=create'],
          },
        }),
      }));
      await expect(
        resumeUpdatePreparation(
          root,
          await dockerUpdatePreparation({
            managedRoot: root,
            docker,
            environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
            verifyImage: async () => undefined,
            hostRuntimeDir,
            log,
          }),
        ),
      ).rejects.toThrow(/runtime service predates archives\. The current version keeps serving/u);
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(
          /Host components not refreshed through the devcontainer builder\..+/u,
        ),
      );
    } finally {
      await rm(hostRuntimeDir, { recursive: true, force: true });
    }
  });

  it('prepares the standby and reports a builder the host components cannot update', async () => {
    const { root } = await setup();
    const hostRuntimeDir = await mkdtemp(join(tmpdir(), 'verity-host-builder-'));
    const docker = fakeDocker();
    const log = vi.fn();
    try {
      await writeFile(
        join(hostRuntimeDir, 'devcontainer-builder.json'),
        '{"version":1,"gid":1102}',
      );
      // Installed before verity-host-builder existed: no `builder` trigger.
      await writeFile(
        join(hostRuntimeDir, 'agent.json'),
        JSON.stringify({ version: 1, trigger: 'systemd-path' }),
      );
      docker.inspectImageLabels = vi.fn(async () => ({
        'org.verity.devcontainer-builder': DEVCONTAINER_BUILDER_CONTRACT,
      }));
      await expect(
        resumeUpdatePreparation(
          root,
          await dockerUpdatePreparation({
            managedRoot: root,
            docker,
            environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
            verifyImage: async () => undefined,
            hostRuntimeDir,
            log,
          }),
        ),
      ).resolves.toMatchObject({ phase: 'standby' });
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(
          /Devcontainer builder not updated.*Re-run the Verity installer once/su,
        ),
      );
    } finally {
      await rm(hostRuntimeDir, { recursive: true, force: true });
    }
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

  /**
   * A failed preparation pull is terminal: the journal moves to `failed` and the
   * device has to ask again. The incident this guards against was a pull that
   * failed the same way on every attempt and needed a click each time; a stall
   * or a dropped connection must instead be retried here, without anyone asking,
   * and still stop after a bounded number of attempts.
   */
  describe('retrying the Server image pull', () => {
    const stalled = () =>
      new DockerError({
        kind: 'pull_stalled',
        image: newImage,
        idleMs: 120_000,
        message: `image pull of ${newImage} stalled`,
      });
    const prepare = async (docker: FakeDocker, sleep: (ms: number) => Promise<unknown>) => {
      const { root } = await setup();
      const log = vi.fn<(message: string) => void>();
      const run = resumeUpdatePreparation(
        root,
        await dockerUpdatePreparation({
          managedRoot: root,
          docker,
          environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
          verifyImage: async () => undefined,
          pullRetrySleep: sleep,
          log,
        }),
      );
      return { root, run, log };
    };

    it('retries a stalled pull on its own and reaches standby', async () => {
      const docker = fakeDocker();
      docker.pullImage
        .mockRejectedValueOnce(stalled())
        .mockRejectedValueOnce(new DockerError({ kind: 'network', cause: new Error('reset') }))
        .mockResolvedValueOnce(undefined);
      const sleep = vi.fn<(ms: number) => Promise<unknown>>(async () => undefined);
      const { run, log } = await prepare(docker, sleep);
      await expect(run).resolves.toMatchObject({ phase: 'standby' });
      expect(docker.pullImage.mock.calls.map(([ref]) => ref)).toEqual([
        newImage,
        newImage,
        newImage,
      ]);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(UPDATE_PULL_RETRY_DELAYS_MS.slice(0, 2));
      expect(log.mock.calls.some(([line]) => line.includes('retrying'))).toBe(true);
    });

    it('stops after its bound and fails the operation with the last stall', async () => {
      const docker = fakeDocker();
      docker.pullImage.mockImplementation(async () => {
        throw stalled();
      });
      const sleep = vi.fn<(ms: number) => Promise<unknown>>(async () => undefined);
      const { root, run } = await prepare(docker, sleep);
      await expect(run).rejects.toMatchObject({ kind: 'pull_stalled' });
      expect(docker.pullImage).toHaveBeenCalledTimes(UPDATE_PULL_RETRY_DELAYS_MS.length + 1);
      expect(sleep).toHaveBeenCalledTimes(UPDATE_PULL_RETRY_DELAYS_MS.length);
      await expect(readUpdateJournal(root)).resolves.toMatchObject({ phase: 'failed' });
    });

    it('does not spend the ceiling a second time', async () => {
      const docker = fakeDocker();
      docker.pullImage.mockRejectedValue(
        new DockerError({
          kind: 'timeout',
          image: newImage,
          timeoutMs: 7_200_000,
          message: `image pull of ${newImage} did not finish`,
        }),
      );
      const sleep = vi.fn<(ms: number) => Promise<unknown>>(async () => undefined);
      const { run } = await prepare(docker, sleep);
      await expect(run).rejects.toMatchObject({ kind: 'timeout' });
      expect(docker.pullImage).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
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

describe('backup preparation before standby activation', () => {
  it('requires corrected updater orchestration to resume the original pinned operation, even after a receipt exists', async () => {
    const { root } = await setup({ pairing: true });
    for (const [from, to] of [
      ['requested', 'pulling'],
      ['pulling', 'verifying-image'],
      ['verifying-image', 'preflight'],
      ['preflight', 'creating-standby'],
    ] as const)
      await advanceUpdate(root, from, to);
    const journal = await readUpdateJournal(root);
    if (!journal) throw new Error('missing recovery journal');
    const docker = fakeDocker();
    docker.inspectImageLabels.mockResolvedValue({ 'org.verity.backup-provisioning': '1' });
    docker.listContainers.mockResolvedValue([
      {
        id: 'b'.repeat(64),
        imageId: 'sha256:' + 'c'.repeat(64),
        labels: { 'com.docker.compose.service': 'postgres' },
      },
    ]);
    docker.inspectContainer.mockResolvedValue({
      running: true,
      networks: { 'verity-net': {} },
    } as unknown as ContainerInspect);
    let provisioned = false;
    const lastJob = () => docker.createContainer.mock.calls.at(-1)?.[0];
    docker.containerLogs.mockImplementation(async () =>
      JSON.stringify({
        version: 1,
        statePath: '/etc/verity',
        backupPath: '/srv/archives',
        identityPath: '/var/lib/verity/backup-identity',
        provisioned,
      }),
    );
    docker.waitContainer.mockImplementation(async () => {
      const job = lastJob();
      if (job?.command?.[0] !== '/opt/verity-install/deploy/host/verity-backup-provision') return 0;
      if (job.pidMode !== 'host' || !job.env?.includes('SYSTEMD_IGNORE_CHROOT=1')) return 1;
      provisioned = true;
      return 0;
    });
    // Model the old creator's omitted fields, using the actual preparation and
    // provisioning implementations rather than mocking the host hook away.
    const legacy = {
      ...docker,
      createContainer: async (spec: ContainerSpec) => {
        const copy = {
          ...spec,
          env: (spec.env ?? []).filter((entry) => entry !== 'SYSTEMD_IGNORE_CHROOT=1'),
        };
        delete copy.pidMode;
        return docker.createContainer(copy);
      },
    };
    const actions = (client: UpdatePreparationDocker) =>
      dockerUpdatePreparation({
        managedRoot: root,
        docker: client,
        environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
        verifyImage: async () => undefined,
      });
    const oldUpdater = await actions(legacy);
    await expect(oldUpdater.prepareStandby!(journal)).rejects.toThrow(
      'previous Server remains active',
    );
    provisioned = true;
    await expect(oldUpdater.prepareStandby!(journal)).rejects.toThrow(
      'previous Server remains active',
    );
    const correctedUpdater = await actions(docker);
    await correctedUpdater.prepareStandby!(journal);
    await correctedUpdater.ensureStandby(journal);
    expect(lastJob()).toMatchObject({
      image: journal.targetDigest,
      name: `verity-managed-server-g${String(journal.generation)}`,
    });
    expect(lastJob()?.binds).toContain('/srv/archives:/run/verity-backups');
    expect(await readUpdateJournal(root)).toEqual(journal);
    expect(docker.removeContainer.mock.calls.every(([id]) => id === 'a'.repeat(64))).toBe(true);
  });

  it.each([false, true])(
    'seals backup mounts only after host verification (fail=%s)',
    async (fail) => {
      const { root, journal } = await setup({ pairing: true });
      const docker = fakeDocker();
      docker.inspectImageLabels.mockResolvedValue({ 'org.verity.backup-provisioning': '1' });
      docker.listContainers.mockResolvedValue([
        {
          id: 'b'.repeat(64),
          imageId: 'sha256:' + 'c'.repeat(64),
          labels: { 'com.docker.compose.service': 'postgres' },
        },
      ]);
      docker.inspectContainer.mockResolvedValue({
        running: true,
        networks: { 'verity-net': {} },
      } as unknown as ContainerInspect);
      const plan = {
        version: 1,
        statePath: '/etc/verity',
        backupPath: '/srv/archives',
        identityPath: '/var/lib/verity/backup-identity',
        provisioned: false,
      };
      docker.containerLogs
        .mockResolvedValueOnce(JSON.stringify(plan))
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce(JSON.stringify({ ...plan, provisioned: true }));
      if (fail) docker.waitContainer.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
      const actions = await dockerUpdatePreparation({
        managedRoot: root,
        docker,
        environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
        verifyImage: async () => undefined,
      });
      if (fail) {
        await expect(actions.prepareStandby!(journal)).rejects.toThrow(
          'previous Server remains active',
        );
        const state = await readManagedDeployment(root);
        expect(
          state.managed &&
            state.spec.mounts.some((mount) => mount.target === '/run/verity-backups'),
        ).toBe(false);
        expect(
          docker.createContainer.mock.calls.every(
            ([request]) => request.labels?.['verity.managed-role'] === 'backup-provisioning',
          ),
        ).toBe(true);
      } else {
        await actions.prepareStandby!(journal);
        await actions.ensureStandby(journal);
        expect(docker.createContainer.mock.calls.at(-1)?.[0].binds).toContain(
          '/srv/archives:/run/verity-backups',
        );
      }
      // Host preparation never stops or removes the serving generation.
      expect(docker.removeContainer.mock.calls.every(([id]) => id === 'a'.repeat(64))).toBe(true);
    },
  );
});

it.each(['single', 'ambiguous'])(
  'renews only a uniquely owned legacy host service (%s)',
  async (ownership) => {
    const { root, journal } = await setup({ pairing: true });
    const hostRuntimeDir = await mkdtemp(join(tmpdir(), 'runtime-renewal-integration-'));
    const jobs = new Map<string, { spec: ContainerSpec; status: string }>();
    const docker = fakeDocker();
    const runtimes = new Map<string, { path: string; args: string[] }>();
    const requirements = {
      release: 'release-20261026.0',
      sha512: { x86_64: 'a'.repeat(128), aarch64: 'b'.repeat(128) },
      archiveSha512: { x86_64: 'c'.repeat(128), aarch64: 'd'.repeat(128) },
      runtimes: {
        runsc: ['--platform=systrap', '--network=none'],
        'runsc-project': ['--platform=systrap', '--network=sandbox', '--host-uds=create'],
      },
    };
    const service = { revision: 1, renewalProtocol: 1, features: ['binary', 'archive'] };
    docker.inspectImageLabels.mockResolvedValue({
      'org.verity.host-runtimes': JSON.stringify(requirements),
      'org.verity.host-runtime-service': JSON.stringify(service),
      'org.verity.devcontainer-builder': DEVCONTAINER_BUILDER_CONTRACT,
    });
    docker.listContainers.mockImplementation(async () => [
      {
        id: 'updater',
        imageId: oldImage,
        names: ['updater'],
        labels: {
          'verity.managed-deployment-id': journal.deploymentId,
          'verity.managed-role': 'updater',
        },
      },
      ...[...jobs].map(([id, job]) => ({
        id,
        imageId: job.spec.image,
        names: [job.spec.name],
        labels: job.spec.labels ?? {},
      })),
    ]);
    if (ownership === 'ambiguous') {
      const list = docker.listContainers.getMockImplementation()!;
      docker.listContainers.mockImplementation(async () => {
        const containers = await list();
        return [...containers, { ...containers[0]!, id: 'updater-duplicate' }];
      });
    }
    docker.inspectContainer.mockImplementation(async (id) =>
      id.startsWith('updater')
        ? {
            id,
            running: true,
            image: oldImage,
            mounts: [
              {
                type: 'bind',
                source: '/var/lib/verity/host-runtime',
                destination: '/run/verity-host-runtime',
              },
            ],
          }
        : { ...inspectFromSpec(jobs.get(id)!.spec, jobs.get(id)!.status), id },
    );
    docker.createContainer.mockImplementation(async (spec) => {
      const id = String(jobs.size + 1).repeat(64);
      jobs.set(id, { spec, status: 'created' });
      return { id, warnings: [] };
    });
    docker.startContainer.mockImplementation(async (id) => {
      jobs.get(id)!.status = 'running';
    });
    docker.waitContainer.mockImplementation(async (id) => {
      const job = jobs.get(id)!;
      job.status = 'exited';
      if (job.spec.labels?.['verity.renewal-stage'] === 'install') {
        await writeFile(
          join(hostRuntimeDir, 'agent.json'),
          JSON.stringify({
            version: 1,
            trigger: 'systemd-path',
            builder: 'none',
            runtimeArtifacts: ['binary', 'archive'],
            runtimeService: {
              ...service,
              sha512: 'f'.repeat(128),
              receipt: {
                deploymentId: journal.deploymentId,
                updateId: journal.updateId,
                targetDigest: journal.targetDigest,
              },
            },
          }),
        );
      }
      return 0;
    });
    docker.removeContainer.mockImplementation(async (id) => {
      jobs.delete(id);
    });
    const host = setInterval(() => {
      void readFile(join(hostRuntimeDir, 'request.json'), 'utf8').then(
        async (body) => {
          const request = JSON.parse(body) as { id: string };
          for (const [name, args] of Object.entries(requirements.runtimes))
            runtimes.set(name, { path: `/opt/verity/runsc/${requirements.release}/runsc`, args });
          await writeFile(
            join(hostRuntimeDir, 'result.json'),
            JSON.stringify({ version: 1, id: request.id, ok: true }),
          );
        },
        () => undefined,
      );
    }, 5);
    try {
      await writeFile(
        join(hostRuntimeDir, 'agent.json'),
        JSON.stringify({ version: 1, trigger: 'systemd-path', builder: 'none' }),
      );
      const actions = await dockerUpdatePreparation({
        managedRoot: root,
        docker: { ...docker, inspectRuntime: async (name) => runtimes.get(name) },
        environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
        verifyImage: async () => undefined,
        hostRuntimeDir,
      });
      if (ownership === 'ambiguous') {
        await expect(actions.reconcileHostRuntimes!(journal)).rejects.toThrow(
          'one trusted installed updater',
        );
        expect(docker.createContainer).not.toHaveBeenCalled();
        return;
      }
      await actions.reconcileHostRuntimes!(journal);
      expect(
        docker.createContainer.mock.calls.map(([spec]) => spec.labels?.['verity.renewal-stage']),
      ).toEqual(['verify', 'install']);
      await expect(readFile(join(hostRuntimeDir, 'builder-request.json'))).rejects.toThrow(
        /ENOENT/u,
      );
      expect(runtimes.get('runsc')?.path).toContain(requirements.release);
    } finally {
      clearInterval(host);
      await rm(hostRuntimeDir, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('prepares host runtimes using the installed live-smoke service instead of inventing updater ownership', async () => {
  const { root, journal } = await setup();
  try {
    const dockerfile = readFileSync('deploy/Dockerfile', 'utf8');
    const label = (name: string) => {
      const line = dockerfile.split('\n').find((entry) => entry.startsWith(`LABEL ${name}=`))!;
      const encoded: unknown = JSON.parse(line.slice(line.indexOf('=') + 1));
      if (typeof encoded !== 'string') throw new Error('Dockerfile label must be encoded JSON');
      return JSON.parse(encoded) as Record<string, unknown>;
    };
    const requirements = label('org.verity.host-runtimes') as {
      release: string;
      runtimes: Record<string, string[]>;
    };
    const service = label('org.verity.host-runtime-service');
    const docker = {
      ...fakeDocker(),
      inspectRuntime: vi.fn(
        async (name: string): Promise<{ path: string; args: string[] } | undefined> => ({
          path: `/opt/verity/runsc/${requirements.release}/runsc`,
          args: requirements.runtimes[name]!,
        }),
      ),
    };
    docker.inspectImageLabels.mockResolvedValue({
      'org.verity.host-runtimes': JSON.stringify(requirements),
      'org.verity.host-runtime-service': JSON.stringify(service),
    });
    const hostRuntimeDir = join(root, 'runtime-service-fixture/state');
    const actions = await dockerUpdatePreparation({
      managedRoot: root,
      docker,
      hostRuntimeDir,
      environment: { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID: 'deployment-1' },
      verifyImage: async () => undefined,
    });
    await expect(actions.reconcileHostRuntimes!(journal)).rejects.toThrow(
      'one trusted installed updater',
    );
    const driver = readFileSync('deploy/bin/verity-self-update-live-smoke', 'utf8');
    const block = driver
      .split('# BEGIN installed runtime fixture\n')[1]
      ?.split('# END installed runtime fixture')[0];
    expect(block).toBeTypeOf('string');
    execFileSync(
      'bash',
      ['-euc', 'managed_root="$SMOKE_FIXTURE_ROOT"\nrepo_root="$PWD"\n' + block],
      {
        env: { ...process.env, SMOKE_FIXTURE_ROOT: root, VERITY_HOST_RUNTIME_TEST: '1' },
      },
    );
    const agent = JSON.parse(await readFile(join(hostRuntimeDir, 'agent.json'), 'utf8')) as {
      trigger: string;
      runtimeService: { sha512: string };
    };
    expect(agent.trigger).toBe('none');
    expect(agent.runtimeService.sha512).toMatch(/^[a-f0-9]{128}$/u);
    expect(readFileSync('packages/server/src/self-update-live-smoke.ts', 'utf8')).toContain(
      "hostRuntimeDir: required('VERITY_SMOKE_HOST_RUNTIME_DIR')",
    );
    await actions.reconcileHostRuntimes!(journal);
    expect(docker.inspectRuntime).toHaveBeenCalledWith('runsc');
    expect(docker.inspectRuntime).toHaveBeenCalledWith('runsc-project');
    expect(docker.createContainer).not.toHaveBeenCalled();
    expect(docker.listContainers).toHaveBeenCalledTimes(2);
    // A receipt cannot conceal a wrong runtime registration on the daemon.
    docker.inspectRuntime.mockResolvedValue(undefined);
    await expect(actions.reconcileHostRuntimes!(journal)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
