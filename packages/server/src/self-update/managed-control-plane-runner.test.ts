import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  DockerError,
  type ContainerInspect,
  type ContainerSpec,
  type DockerContainerSummary,
} from '../docker.js';
import type { ServerDeploymentSpecBody } from './deployment-spec.js';
import { initializeManagedDeployment } from './managed-deployment.js';
import {
  MANAGED_CONTROL_PLANE_RUNNER_INIT_NAME,
  MANAGED_CONTROL_PLANE_RUNNER_NAME,
  reconcileManagedControlPlaneRunner,
  type ManagedControlPlaneRunnerDocker,
} from './managed-control-plane-runner.js';
import { MANAGED_DEPLOYMENT_LABEL, MANAGED_ROLE_LABEL } from './managed-server-owner.js';

const image = `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`;

async function authority(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'managed-control-runner-'));
  const spec: Omit<ServerDeploymentSpecBody, 'schemaVersion' | 'deploymentId'> = {
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
        source: { kind: 'volume', name: 'verity-control-runner-runtime' },
        target: '/srv/verity/runners/verity-control',
        readOnly: false,
      },
      {
        source: { kind: 'volume', name: 'verity-control-runner-identity' },
        target: '/run/verity-control-identity',
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
  };
  await initializeManagedDeployment({ root, deploymentId: 'deployment-1', spec });
  return root;
}

/** A sealed deployment from before the control-plane Runner existed: valid, but
 *  it never agreed to hand the runtime volume over. */
async function authorityWithoutRunnerVolumes(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'managed-control-runner-plain-'));
  const spec: Omit<ServerDeploymentSpecBody, 'schemaVersion' | 'deploymentId'> = {
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
  };
  await initializeManagedDeployment({ root, deploymentId: 'deployment-1', spec });
  return root;
}

function client(
  summaries: DockerContainerSummary[] = [],
  inspections: Record<string, ContainerInspect> = {},
  wait: () => Promise<number> = async () => 0,
): ManagedControlPlaneRunnerDocker & {
  createContainer: ReturnType<typeof vi.fn>;
  startContainer: ReturnType<typeof vi.fn>;
  stopContainer: ReturnType<typeof vi.fn>;
  removeContainer: ReturnType<typeof vi.fn>;
  waitContainer: ReturnType<typeof vi.fn>;
} {
  return {
    listContainers: vi.fn(async () => summaries),
    inspectContainer: vi.fn(async (id: string) =>
      id === 'created' ? { id, running: true } : inspections[id]!,
    ),
    // The preparation run and the Runner itself are told apart by id so a test can
    // assert the order of the two, which is the whole point of the preparation.
    createContainer: vi.fn(async (spec: ContainerSpec) => ({
      id: spec.name === MANAGED_CONTROL_PLANE_RUNNER_INIT_NAME ? 'prepared' : 'created',
      warnings: [],
    })),
    startContainer: vi.fn(async () => undefined),
    stopContainer: vi.fn(async () => undefined),
    removeContainer: vi.fn(async () => undefined),
    waitContainer: vi.fn(wait),
    pullImage: vi.fn(async () => undefined),
  };
}

/** `client()` deliberately types its spies loosely so every test can reshape
 *  them; this pins one back to the daemon signature so a per-container
 *  implementation type-checks. */
const spy = <T extends (...args: never[]) => unknown>(fn: unknown): Mock<T> => fn as Mock<T>;

const environment = {
  VERITY_CONTROL_PLANE_RUNNER: '1',
  VERITY_RUNNER_RUNTIME_GID: '1101',
};
// `socketGid` is injected for EVERY test, not only the ADR 0006 Amendment 1 ones: otherwise
// `resolveDockerSocket` stats the real /var/run/docker.sock, and the Runner spec
// these tests assert against would depend on whether the machine running them
// happens to have a Docker daemon — passing on a developer laptop and failing in
// a container, or the reverse.
const immediate = {
  startupSettlingMs: 0,
  sleep: async () => undefined,
  socketGid: async () => 986,
};

/**
 * A daemon client that never had a capability — the key ABSENT, not present with
 * an `undefined` value. The guards under test read `=== undefined`, but that is
 * a shape `exactOptionalPropertyTypes` refuses to let an optional method be
 * written as, and one a real client cannot have either.
 */
function withoutCapability<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const rest = { ...value } as Record<PropertyKey, unknown>;
  delete rest[key];
  return rest as unknown as Omit<T, K>;
}

describe('managed control-plane Runner ownership', () => {
  it('creates a digest-pinned Runner with the private runtime boundary', async () => {
    const docker = client();
    await reconcileManagedControlPlaneRunner({
      managedRoot: await authority(),
      docker,
      environment,
      ...immediate,
    });

    expect(docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        image,
        name: MANAGED_CONTROL_PLANE_RUNNER_NAME,
        entrypoint: ['/usr/bin/tini', '--', '/usr/local/bin/verity-control-plane-runner-start'],
        // The runtime GID, then the docker group the socket below is owned by
        // (ADR 0006 Amendment 1). The second is read off the mounted inode, never configured.
        groupAdd: ['1101', '986'],
        // A BIND, not a volume mount: the daemon socket is a host path, and
        // `volumeMounts` resolves its source by named volume. The host path comes
        // from the sealed Server spec, so both containers follow a host that
        // keeps its socket somewhere else.
        binds: ['/var/run/docker.sock:/var/run/docker.sock'],
        volumeMounts: expect.arrayContaining([
          { volume: 'verity-control-runner-runtime', target: '/run/verity-runner' },
          {
            volume: 'verity-control-runner-identity',
            target: '/run/verity-control-identity',
            readOnly: true,
          },
        ]),
        // Equal to the memory ceiling, which is how Docker spells "no swap".
        // Omitting it would default to twice the limit, so taking ownership from
        // Compose — whose `memswap_limit` matched its `mem_limit` — would
        // silently hand the Runner a swap allowance Compose denied it.
        memoryBytes: 4 * 1024 * 1024 * 1024,
        memorySwapBytes: 4 * 1024 * 1024 * 1024,
        env: expect.arrayContaining([
          'VERITY_CODEX_EGRESS_URL=https://verity-agent-gateway:9444',
          'VERITY_CODEX_EGRESS_AUTHORITY=verity-agent-gateway:9444',
        ]),
      }),
    );
    expect(docker.startContainer).toHaveBeenCalledWith('created');
  });

  it('retires the stale Compose companion before starting the managed one', async () => {
    const docker = client(
      [
        {
          id: 'legacy',
          imageId: 'sha256:old',
          names: ['verity-verity-control-runner-1'],
          labels: { 'com.docker.compose.service': 'verity-control-runner' },
        },
      ],
      {
        legacy: {
          id: 'legacy',
          running: true,
          image: 'sha256:old',
          mounts: [{ type: 'volume', name: 'verity-control-runner-runtime' }],
        },
      },
    );
    await reconcileManagedControlPlaneRunner({
      managedRoot: await authority(),
      docker,
      environment,
      ...immediate,
    });

    expect(docker.stopContainer).toHaveBeenCalledWith('legacy');
    expect(docker.removeContainer).toHaveBeenCalledWith('legacy');
    expect(docker.startContainer).toHaveBeenCalledWith('created');
  });

  it('leaves the matching managed Runner running', async () => {
    const docker = client(
      [
        {
          id: 'managed',
          imageId: 'sha256:new',
          names: [MANAGED_CONTROL_PLANE_RUNNER_NAME],
        },
      ],
      {
        managed: {
          id: 'managed',
          running: true,
          image,
          labels: {
            [MANAGED_DEPLOYMENT_LABEL]: 'deployment-1',
            [MANAGED_ROLE_LABEL]: 'control-plane-runner',
          },
          // A Runner that is genuinely up to date carries the ADR 0006 Amendment 1 socket,
          // and the up-to-date check now says so: mounts are fixed at creation,
          // so a Runner without it can only be brought into line by a recreate.
          mounts: [
            { type: 'bind', source: '/var/run/docker.sock', destination: '/var/run/docker.sock' },
          ],
          groupAdd: ['1101', '986'],
        },
      },
    );
    await reconcileManagedControlPlaneRunner({
      managedRoot: await authority(),
      docker,
      environment,
      ...immediate,
    });
    // Preparation runs unconditionally — a Runner already up against a wrongly
    // prepared volume is exactly the case a skip would perpetuate. What must not
    // happen is recreating the Runner itself.
    expect(docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({ name: MANAGED_CONTROL_PLANE_RUNNER_INIT_NAME }),
    );
    expect(docker.createContainer).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: MANAGED_CONTROL_PLANE_RUNNER_NAME }),
    );
    expect(docker.stopContainer).not.toHaveBeenCalledWith('managed');
  });

  /**
   * ADR 0006 Amendment 1's kill switch, on the topology where it can remove the mount.
   *
   * A switch that leaves the socket in place has not killed anything, so assert
   * the bind and the docker group are both GONE — not merely undocumented — and
   * that the runtime GID survives, since withdrawing the Docker grant must not
   * take the Runner's own runtime group with it.
   */
  it('withholds the daemon socket when the operator turns the grant off', async () => {
    for (const value of ['0', 'false', 'FALSE']) {
      const docker = client();
      await reconcileManagedControlPlaneRunner({
        managedRoot: await authority(),
        docker,
        environment: { ...environment, VERITY_CONTROL_PLANE_RUNNER_DOCKER: value },
        ...immediate,
      });
      const spec = docker.createContainer.mock.calls
        .map((call) => call[0] as ContainerSpec)
        .find((created) => created.name === MANAGED_CONTROL_PLANE_RUNNER_NAME);
      expect(spec?.binds, value).toBeUndefined();
      expect(spec?.groupAdd, value).toEqual(['1101']);
      expect(spec?.env, value).toContain('VERITY_CONTROL_PLANE_RUNNER_DOCKER=0');
    }
  });

  /**
   * DEFAULT ON is the operator's decision, so the flag's polarity is inverted
   * from every other one in this file and a value nobody meant must not switch
   * the diagnostics console off by accident. Only an explicit `0`/`false` does.
   */
  it('keeps the grant on for any value that is not an explicit refusal', async () => {
    for (const value of ['1', 'true', '', 'yes', 'off']) {
      const docker = client();
      await reconcileManagedControlPlaneRunner({
        managedRoot: await authority(),
        docker,
        environment: { ...environment, VERITY_CONTROL_PLANE_RUNNER_DOCKER: value },
        ...immediate,
      });
      const spec = docker.createContainer.mock.calls
        .map((call) => call[0] as ContainerSpec)
        .find((created) => created.name === MANAGED_CONTROL_PLANE_RUNNER_NAME);
      expect(spec?.binds, value).toEqual(['/var/run/docker.sock:/var/run/docker.sock']);
    }
  });

  /**
   * Mounts are fixed when a container is created, so a running Runner cannot
   * acquire or lose the socket in place — only a recreate can move it. Until ADR
   * 0006 Amendment 1 this reconcile recreated on a changed image or a stopped
   * container alone, which would have made a mount-only change invisible on
   * every host that had already converged: the Runner would keep running,
   * correct by both tests, and simply never gain the socket. The reverse matters
   * more — a kill switch that reported success while the socket stayed mounted.
   */
  it('recreates a running Runner whose socket grant disagrees with the desired one', async () => {
    const socket = {
      type: 'bind',
      source: '/var/run/docker.sock',
      destination: '/var/run/docker.sock',
    } as const;
    for (const [flag, mounts, groupAdd] of [
      // Granted now, but running without it: the rollout case.
      ['1', [], ['1101']],
      // Withdrawn now, but still running with it: the kill-switch case.
      ['0', [socket], ['1101', '986']],
      // Same destination, different HOST path: the host moved its socket and the
      // Runner is still bound to where it used to be. Both mounts land on
      // /var/run/docker.sock inside the container, so a destination-only
      // comparison calls this converged forever and leaves the container bound to
      // a path that no longer exists.
      [
        '1',
        [{ type: 'bind', source: '/run/docker.sock', destination: '/var/run/docker.sock' }],
        ['1101', '986'],
      ],
      // Right path, WRONG group: the host renumbered its docker group, which a
      // reinstall does. The launcher reads the GID when the container starts, so
      // one that keeps running holds the stale number for life and hands
      // `--groups=<stale>` to every agent — EACCES, reading as a broken daemon.
      ['1', [socket], ['1101', '985']],
      // And a Runner created before the grant existed, which carries the mount by
      // some other route but no docker group at all.
      ['1', [socket], undefined],
    ] as const) {
      const docker = client(
        [{ id: 'managed', imageId: 'sha256:new', names: [MANAGED_CONTROL_PLANE_RUNNER_NAME] }],
        {
          managed: {
            id: 'managed',
            running: true,
            image,
            labels: {
              [MANAGED_DEPLOYMENT_LABEL]: 'deployment-1',
              [MANAGED_ROLE_LABEL]: 'control-plane-runner',
            },
            mounts: [...mounts],
            ...(groupAdd === undefined ? {} : { groupAdd: [...groupAdd] }),
          },
        },
      );
      await reconcileManagedControlPlaneRunner({
        managedRoot: await authority(),
        docker,
        environment: { ...environment, VERITY_CONTROL_PLANE_RUNNER_DOCKER: flag },
        ...immediate,
      });
      expect(docker.removeContainer, flag).toHaveBeenCalledWith('managed');
      expect(docker.createContainer, flag).toHaveBeenCalledWith(
        expect.objectContaining({ name: MANAGED_CONTROL_PLANE_RUNNER_NAME }),
      );
    }
  });

  /**
   * A socket that cannot be stat'ed is a degraded diagnostics console; a
   * reconcile that throws is no control plane at all. Fail soft, and make sure
   * the Runner is still created — with the socket withheld rather than mounted
   * against a GID nobody could read, which would produce a file the agent cannot
   * open and no way to tell that from the feature being off.
   */
  it('still builds a Runner when the socket group cannot be read', async () => {
    const docker = client();
    await reconcileManagedControlPlaneRunner({
      managedRoot: await authority(),
      docker,
      environment,
      ...immediate,
      socketGid: async () => {
        throw new Error('ENOENT');
      },
    });
    const spec = docker.createContainer.mock.calls
      .map((call) => call[0] as ContainerSpec)
      .find((created) => created.name === MANAGED_CONTROL_PLANE_RUNNER_NAME);
    expect(spec).toBeDefined();
    expect(spec?.binds).toBeUndefined();
    expect(spec?.groupAdd).toEqual(['1101']);
  });

  it('reaps a Compose companion standing beside an already-correct managed Runner', async () => {
    // The retirement above only ran on the create path, so a host that had
    // already converged never cleaned up a Compose Runner that a later
    // `verity-install` recreated. That is not cosmetic: the supervisor lock is
    // exclusive across containers, so the Compose one cannot start at all while
    // the managed one holds it — it crash-loops on "runner supervisor is already
    // claimed" indefinitely (observed at 91 restarts and climbing), and every
    // converge brings it back.
    const docker = client(
      [
        {
          id: 'managed',
          imageId: 'sha256:new',
          names: [MANAGED_CONTROL_PLANE_RUNNER_NAME],
        },
        {
          id: 'legacy',
          imageId: 'sha256:old',
          names: ['verity-verity-control-runner-1'],
          labels: { 'com.docker.compose.service': 'verity-control-runner' },
        },
      ],
      {
        managed: {
          id: 'managed',
          running: true,
          image,
          labels: {
            [MANAGED_DEPLOYMENT_LABEL]: 'deployment-1',
            [MANAGED_ROLE_LABEL]: 'control-plane-runner',
          },
          // A Runner that is genuinely up to date carries the ADR 0006 Amendment 1 socket,
          // and the up-to-date check now says so: mounts are fixed at creation,
          // so a Runner without it can only be brought into line by a recreate.
          mounts: [
            { type: 'bind', source: '/var/run/docker.sock', destination: '/var/run/docker.sock' },
          ],
          groupAdd: ['1101', '986'],
        },
        legacy: {
          id: 'legacy',
          running: true,
          image: 'sha256:old',
          mounts: [{ type: 'volume', name: 'verity-control-runner-runtime' }],
        },
      },
    );
    await reconcileManagedControlPlaneRunner({
      managedRoot: await authority(),
      docker,
      environment,
      ...immediate,
    });

    expect(docker.removeContainer).toHaveBeenCalledWith('legacy');
    // The healthy managed Runner keeps the lock throughout — there is nothing to
    // hand over, so it must not be disturbed to make room for the reap.
    expect(docker.stopContainer).not.toHaveBeenCalledWith('managed');
    expect(docker.removeContainer).not.toHaveBeenCalledWith('managed');
    expect(docker.createContainer).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: MANAGED_CONTROL_PLANE_RUNNER_NAME }),
    );
  });

  it('spares a same-named Compose service that does not share the runtime volume', async () => {
    // The service label alone is not identity. Reaping now runs on every healthy
    // reconcile, so matching on the name alone would let this Server stop and
    // remove an unrelated project's container over and over. What makes a
    // container a rival is holding the volume whose `supervisor.lock` the two
    // would contend for — a container without it takes nothing from us.
    const docker = client(
      [
        {
          id: 'managed',
          imageId: 'sha256:new',
          names: [MANAGED_CONTROL_PLANE_RUNNER_NAME],
        },
        {
          id: 'stranger',
          imageId: 'sha256:other',
          names: ['someone-else-verity-control-runner-1'],
          labels: { 'com.docker.compose.service': 'verity-control-runner' },
        },
      ],
      {
        managed: {
          id: 'managed',
          running: true,
          image,
          labels: {
            [MANAGED_DEPLOYMENT_LABEL]: 'deployment-1',
            [MANAGED_ROLE_LABEL]: 'control-plane-runner',
          },
          // A Runner that is genuinely up to date carries the ADR 0006 Amendment 1 socket,
          // and the up-to-date check now says so: mounts are fixed at creation,
          // so a Runner without it can only be brought into line by a recreate.
          mounts: [
            { type: 'bind', source: '/var/run/docker.sock', destination: '/var/run/docker.sock' },
          ],
          groupAdd: ['1101', '986'],
        },
        stranger: {
          id: 'stranger',
          running: true,
          image: 'sha256:other',
          mounts: [{ type: 'volume', name: 'someone-else_verity-control-runner-runtime' }],
        },
      },
    );
    await reconcileManagedControlPlaneRunner({
      managedRoot: await authority(),
      docker,
      environment,
      ...immediate,
    });

    expect(docker.stopContainer).not.toHaveBeenCalledWith('stranger');
    expect(docker.removeContainer).not.toHaveBeenCalledWith('stranger');
  });

  it('prepares the volumes, with setgid, before the Runner that consumes them', async () => {
    const docker = client();
    await reconcileManagedControlPlaneRunner({
      managedRoot: await authority(),
      docker,
      environment,
      ...immediate,
    });

    const created = docker.createContainer.mock.calls.map(
      (call) => (call[0] as ContainerSpec).name,
    );
    expect(created).toEqual([
      MANAGED_CONTROL_PLANE_RUNNER_INIT_NAME,
      MANAGED_CONTROL_PLANE_RUNNER_NAME,
    ]);

    const [prepare] = docker.createContainer.mock.calls[0] as [ContainerSpec];
    expect(prepare.user).toBe('root');
    expect(prepare.volumeMounts).toEqual(
      expect.arrayContaining([
        { volume: 'verity-control-runner-identity', target: '/identity' },
        { volume: 'verity-control-runner-runtime', target: '/runner' },
      ]),
    );
    // Setgid is the whole mechanism: the Server publishes identity unprivileged and
    // cannot chown() it to the Runner, so the group has to be inherited.
    expect(prepare.command?.join(' ')).toContain('chmod 2770 /identity');
    expect(prepare.command?.join(' ')).toContain('chown 0:1101 /identity');
    expect(prepare.command?.join(' ')).toContain('chmod 0170 /runner');
    // Setgid governs only new files, so material published before it existed — and
    // the debris of publishes that failed half-way — is repaired explicitly.
    expect(prepare.command?.join(' ')).toContain('chown :1101');
    expect(prepare.command?.join(' ')).toContain('rm -f');
    // Nothing is left behind for the next reconcile to trip over.
    expect(docker.removeContainer).toHaveBeenCalledWith('prepared');
  });

  it('refuses to remove a foreign container holding the preparation name', async () => {
    const docker = client(
      [{ id: 'squatter', imageId: 'sha256:x', names: [MANAGED_CONTROL_PLANE_RUNNER_INIT_NAME] }],
      { squatter: { id: 'squatter', running: false, image, labels: { owner: 'somebody-else' } } },
    );

    await expect(
      reconcileManagedControlPlaneRunner({
        managedRoot: await authority(),
        docker,
        environment,
        ...immediate,
      }),
    ).rejects.toThrow(/occupied by a foreign container/);

    expect(docker.removeContainer).not.toHaveBeenCalledWith('squatter');
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it('gives up on a preparation run that never finishes', async () => {
    // A wait that never settles: the reconcile must not hang on it.
    const docker = client([], {}, () => new Promise<number>(() => undefined));

    await expect(
      reconcileManagedControlPlaneRunner({
        managedRoot: await authority(),
        docker,
        environment,
        preparationTimeoutMs: 5,
        ...immediate,
      }),
    ).rejects.toThrow(/did not finish in time/);

    expect(docker.removeContainer).toHaveBeenCalledWith('prepared');
    expect(docker.createContainer).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: MANAGED_CONTROL_PLANE_RUNNER_NAME }),
    );
  });

  it('refuses to start the Runner when preparing its volumes fails', async () => {
    const docker = client();
    docker.waitContainer.mockResolvedValueOnce(1);

    await expect(
      reconcileManagedControlPlaneRunner({
        managedRoot: await authority(),
        docker,
        environment,
        ...immediate,
      }),
    ).rejects.toThrow(/volume preparation exited 1/);

    expect(docker.createContainer).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: MANAGED_CONTROL_PLANE_RUNNER_NAME }),
    );
    expect(docker.removeContainer).toHaveBeenCalledWith('prepared');
  });

  it('restores the Compose predecessor when the managed Runner exits during startup', async () => {
    const docker = client(
      [
        {
          id: 'legacy',
          imageId: 'sha256:old',
          names: ['verity-verity-control-runner-1'],
          labels: { 'com.docker.compose.service': 'verity-control-runner' },
        },
      ],
      {
        legacy: {
          id: 'legacy',
          running: true,
          image: 'sha256:old',
          mounts: [{ type: 'volume', name: 'verity-control-runner-runtime' }],
        },
      },
    );
    // Target the container by id rather than by call order: rival detection now
    // inspects the Compose container first, so a `…Once` stub would be spent on
    // that call and the startup proof would see the wrong container.
    vi.mocked(docker.inspectContainer).mockImplementation(async (id: string) =>
      id === 'created'
        ? { id, running: false, status: 'exited' }
        : {
            id: 'legacy',
            running: true,
            image: 'sha256:old',
            mounts: [{ type: 'volume', name: 'verity-control-runner-runtime' }],
          },
    );

    await expect(
      reconcileManagedControlPlaneRunner({
        managedRoot: await authority(),
        docker,
        environment,
        ...immediate,
      }),
    ).rejects.toThrow(/exited during startup/);

    expect(docker.removeContainer).toHaveBeenCalledWith('created');
    expect(docker.startContainer).toHaveBeenLastCalledWith('legacy');
    expect(docker.removeContainer).not.toHaveBeenCalledWith('legacy');
  });

  it('refuses to reconcile on a daemon that cannot list containers', async () => {
    // Without listing, this reconcile cannot see the rivals it must displace or
    // the Runner it may already own — so it would create a second Runner beside
    // the first and both would fight over the supervisor lock.
    const docker = client();

    await expect(
      reconcileManagedControlPlaneRunner({
        managedRoot: await authority(),
        docker: withoutCapability(docker, 'listContainers'),
        environment,
        ...immediate,
      }),
    ).rejects.toThrow('control-plane Runner reconciliation requires Docker container listing');
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it('refuses to reconcile a root that carries no managed authority', async () => {
    // The sealed spec is where the image, the deployment id and the mount list
    // come from. Without it there is nothing to reconcile TOWARDS, and inventing
    // a default would take ownership of containers this Server cannot describe.
    const docker = client();

    await expect(
      reconcileManagedControlPlaneRunner({
        managedRoot: await mkdtemp(join(tmpdir(), 'managed-control-runner-unmanaged-')),
        docker,
        environment,
        ...immediate,
      }),
    ).rejects.toThrow(
      'managed Server authority unavailable: managed deployment has not been initialized',
    );
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it.each([['0'], ['root'], ['-5'], ['01101'], ['1101x']])(
    'refuses %s as the Runner runtime group',
    async (gid) => {
      // This number is interpolated into the preparation container's `chown`
      // commands and handed to the launcher as the group every agent child is
      // dropped into. A value that is not a plain positive GID would either run
      // the wrong chown or hand out group 0.
      const docker = client();

      await expect(
        reconcileManagedControlPlaneRunner({
          managedRoot: await authority(),
          docker,
          environment: { ...environment, VERITY_RUNNER_RUNTIME_GID: gid },
          ...immediate,
        }),
      ).rejects.toThrow('VERITY_RUNNER_RUNTIME_GID must be a positive group ID');
      expect(docker.createContainer).not.toHaveBeenCalled();
    },
  );

  it('falls back to the reserved runtime group when the operator names none', async () => {
    const docker = client();
    await reconcileManagedControlPlaneRunner({
      managedRoot: await authority(),
      docker,
      environment: { VERITY_CONTROL_PLANE_RUNNER: '1' },
      ...immediate,
    });

    const specs = docker.createContainer.mock.calls.map((call) => call[0] as ContainerSpec);
    expect(
      specs
        .find((spec) => spec.name === MANAGED_CONTROL_PLANE_RUNNER_INIT_NAME)
        ?.command?.join(' '),
    ).toContain('chown 0:1101 /identity');
    expect(specs.find((spec) => spec.name === MANAGED_CONTROL_PLANE_RUNNER_NAME)?.groupAdd).toEqual(
      ['1101', '986'],
    );
  });

  it.each([
    ['the operator has not opted in', {}, authority],
    [
      'the flag holds a value that is not an opt-in',
      { VERITY_CONTROL_PLANE_RUNNER: 'yes' },
      authority,
    ],
    [
      'the sealed spec carries no control-runner runtime volume',
      environment,
      authorityWithoutRunnerVolumes,
    ],
    // No `environment` at all: the ambient process environment decides, and this
    // test process is not a managed Server that opted in.
    ['nothing but the ambient process environment says so', undefined, authority],
  ])('takes no ownership while %s', async (_case, env, root) => {
    // Opt-IN, and it takes both halves: the flag AND a sealed spec that actually
    // mounts the runtime volume. Acting on the flag alone would prepare volumes
    // this deployment never agreed to hand over.
    const docker = client();

    await reconcileManagedControlPlaneRunner({
      managedRoot: await root(),
      docker,
      ...(env === undefined ? {} : { environment: env }),
      ...immediate,
    });

    expect(docker.createContainer).not.toHaveBeenCalled();
    expect(docker.stopContainer).not.toHaveBeenCalled();
  });

  it('refuses to prepare volumes on a daemon that cannot report container exits', async () => {
    // The preparation container's exit code is the only evidence the volumes were
    // shaped at all. Starting the Runner without it means starting against
    // volumes of unknown ownership and mode.
    const docker = client();

    await expect(
      reconcileManagedControlPlaneRunner({
        managedRoot: await authority(),
        docker: withoutCapability(docker, 'waitContainer'),
        environment,
        ...immediate,
      }),
    ).rejects.toThrow('control-plane Runner volume preparation requires container wait support');
  });

  it('clears its own leftover preparation container before preparing again', async () => {
    // A crash leaves the preparation container behind under a fixed name. It is
    // this deployment's own, so it is removed rather than treated as a squatter —
    // otherwise every later reconcile refuses on the debris of an earlier one.
    const docker = client(
      [{ id: 'leftover', imageId: 'sha256:x', names: [MANAGED_CONTROL_PLANE_RUNNER_INIT_NAME] }],
      {
        leftover: {
          id: 'leftover',
          running: false,
          image,
          labels: {
            [MANAGED_DEPLOYMENT_LABEL]: 'deployment-1',
            [MANAGED_ROLE_LABEL]: 'control-plane-runner-init',
          },
        },
      },
    );

    await reconcileManagedControlPlaneRunner({
      managedRoot: await authority(),
      docker,
      environment,
      ...immediate,
    });

    expect(docker.removeContainer).toHaveBeenCalledWith('leftover');
    expect(docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({ name: MANAGED_CONTROL_PLANE_RUNNER_INIT_NAME }),
    );
  });

  it('refuses a preparation name held by a container of the same deployment in another role', async () => {
    // Same deployment is not enough. The role label is what says this container
    // is the disposable preparation run; anything else under that name is
    // somebody's live container and removing it is not this reconcile's business.
    const docker = client(
      [{ id: 'other-role', imageId: 'sha256:x', names: [MANAGED_CONTROL_PLANE_RUNNER_INIT_NAME] }],
      {
        'other-role': {
          id: 'other-role',
          running: true,
          image,
          labels: {
            [MANAGED_DEPLOYMENT_LABEL]: 'deployment-1',
            [MANAGED_ROLE_LABEL]: 'control-plane-runner',
          },
        },
      },
    );

    await expect(
      reconcileManagedControlPlaneRunner({
        managedRoot: await authority(),
        docker,
        environment,
        ...immediate,
      }),
    ).rejects.toThrow(
      'managed control-plane Runner preparation name is occupied by a foreign container',
    );
    expect(docker.removeContainer).not.toHaveBeenCalledWith('other-role');
  });

  it('refuses to choose when two containers answer to the Runner name', async () => {
    // Docker cannot produce this, so it means something outside this reconcile is
    // also managing the name. Picking one would leave the other running against
    // the same supervisor lock.
    const docker = client(
      [
        { id: 'one', imageId: 'sha256:a', names: [MANAGED_CONTROL_PLANE_RUNNER_NAME] },
        { id: 'two', imageId: 'sha256:b', names: [MANAGED_CONTROL_PLANE_RUNNER_NAME] },
      ],
      {},
    );

    await expect(
      reconcileManagedControlPlaneRunner({
        managedRoot: await authority(),
        docker,
        environment,
        ...immediate,
      }),
    ).rejects.toThrow('multiple containers use the managed control-plane Runner name');
    expect(docker.removeContainer).not.toHaveBeenCalledWith('one');
    expect(docker.removeContainer).not.toHaveBeenCalledWith('two');
  });

  it.each([
    [
      'another deployment',
      { [MANAGED_DEPLOYMENT_LABEL]: 'deployment-2', [MANAGED_ROLE_LABEL]: 'control-plane-runner' },
    ],
    [
      'another role of this deployment',
      { [MANAGED_DEPLOYMENT_LABEL]: 'deployment-1', [MANAGED_ROLE_LABEL]: 'server' },
    ],
    ['no managed labels at all', {}],
  ])('refuses to displace a container of %s holding the Runner name', async (_case, labels) => {
    // Ownership is both labels together. Either one alone would let this
    // reconcile stop and remove a container it does not own — a neighbouring
    // deployment's Runner, or this deployment's own Server.
    const docker = client(
      [{ id: 'squatter', imageId: 'sha256:x', names: [MANAGED_CONTROL_PLANE_RUNNER_NAME] }],
      { squatter: { id: 'squatter', running: true, image, labels } },
    );

    await expect(
      reconcileManagedControlPlaneRunner({
        managedRoot: await authority(),
        docker,
        environment,
        ...immediate,
      }),
    ).rejects.toThrow('managed control-plane Runner name is occupied by a foreign container');
    expect(docker.stopContainer).not.toHaveBeenCalledWith('squatter');
    expect(docker.removeContainer).not.toHaveBeenCalledWith('squatter');
  });

  it('treats a rival that vanished mid-retirement as already retired', async () => {
    // Two reconciles, or a reconcile racing an operator, can both decide to remove
    // the same Compose Runner. Losing that race produced the outcome we wanted, so
    // it must not fail the reconcile that was about to create the replacement.
    const docker = client(
      [
        {
          id: 'legacy',
          imageId: 'sha256:old',
          names: ['verity-verity-control-runner-1'],
          labels: { 'com.docker.compose.service': 'verity-control-runner' },
        },
      ],
      {
        legacy: {
          id: 'legacy',
          running: true,
          image: 'sha256:old',
          mounts: [{ type: 'volume', name: 'verity-control-runner-runtime' }],
        },
      },
    );
    const gone = new DockerError({ kind: 'container_not_found', id: 'legacy' });
    spy<(id: string) => Promise<void>>(docker.stopContainer).mockImplementation(async (id) => {
      if (id === 'legacy') throw gone;
    });
    spy<(id: string) => Promise<void>>(docker.removeContainer).mockImplementation(async (id) => {
      if (id === 'legacy') throw gone;
    });

    await reconcileManagedControlPlaneRunner({
      managedRoot: await authority(),
      docker,
      environment,
      ...immediate,
    });

    expect(docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({ name: MANAGED_CONTROL_PLANE_RUNNER_NAME }),
    );
    expect(docker.startContainer).toHaveBeenCalledWith('created');
  });

  it.each([
    ['stopContainer', 'stopContainer' as const],
    ['removeContainer', 'removeContainer' as const],
  ])('surfaces a daemon failure from %s instead of reaping past it', async (_case, method) => {
    // Only "the container is already gone" is benign. A daemon that refuses the
    // call has left a rival running, and continuing would start a second Runner
    // against the lock the first still holds.
    const docker = client(
      [
        { id: 'managed', imageId: 'sha256:new', names: [MANAGED_CONTROL_PLANE_RUNNER_NAME] },
        {
          id: 'legacy',
          imageId: 'sha256:old',
          names: ['verity-verity-control-runner-1'],
          labels: { 'com.docker.compose.service': 'verity-control-runner' },
        },
      ],
      {
        managed: {
          id: 'managed',
          running: true,
          image,
          labels: {
            [MANAGED_DEPLOYMENT_LABEL]: 'deployment-1',
            [MANAGED_ROLE_LABEL]: 'control-plane-runner',
          },
          mounts: [
            { type: 'bind', source: '/var/run/docker.sock', destination: '/var/run/docker.sock' },
          ],
          groupAdd: ['1101', '986'],
        },
        legacy: {
          id: 'legacy',
          running: true,
          image: 'sha256:old',
          mounts: [{ type: 'volume', name: 'verity-control-runner-runtime' }],
        },
      },
    );
    spy<(id: string) => Promise<void>>(docker[method]).mockImplementation(async (id) => {
      if (id === 'legacy')
        throw new DockerError({ kind: 'other', status: 500, message: 'daemon is unwell' });
    });

    await expect(
      reconcileManagedControlPlaneRunner({
        managedRoot: await authority(),
        docker,
        environment,
        ...immediate,
      }),
    ).rejects.toThrow('daemon is unwell');
  });

  it('surfaces a daemon failure while standing the predecessor down', async () => {
    // This stop happens between creating the replacement and starting it. A
    // failure here means the predecessor still holds the supervisor lock, so
    // starting the new Runner anyway would produce a crash-looping container.
    const docker = client(
      [
        {
          id: 'legacy',
          imageId: 'sha256:old',
          names: ['verity-verity-control-runner-1'],
          labels: { 'com.docker.compose.service': 'verity-control-runner' },
        },
      ],
      {
        legacy: {
          id: 'legacy',
          running: true,
          image: 'sha256:old',
          mounts: [{ type: 'volume', name: 'verity-control-runner-runtime' }],
        },
      },
    );
    spy<(id: string) => Promise<void>>(docker.stopContainer).mockImplementation(async (id) => {
      if (id === 'legacy')
        throw new DockerError({ kind: 'other', status: 500, message: 'daemon is unwell' });
    });

    await expect(
      reconcileManagedControlPlaneRunner({
        managedRoot: await authority(),
        docker,
        environment,
        ...immediate,
      }),
    ).rejects.toThrow('daemon is unwell');
    expect(docker.startContainer).not.toHaveBeenCalledWith('created');
  });

  it('pulls the sealed image once when the daemon does not have it yet', async () => {
    // The Runner runs the Server's own digest. A host that pruned it would
    // otherwise be left with no control plane and nothing saying why.
    const docker = client();
    let attempts = 0;
    spy<(spec: ContainerSpec) => Promise<{ id: string; warnings: string[] }>>(
      docker.createContainer,
    ).mockImplementation(async (spec) => {
      attempts += 1;
      if (attempts === 1)
        throw new DockerError({
          kind: 'image_not_found',
          image: spec.image,
          message: 'no such image',
        });
      return {
        id: spec.name === MANAGED_CONTROL_PLANE_RUNNER_INIT_NAME ? 'prepared' : 'created',
        warnings: [],
      };
    });

    await reconcileManagedControlPlaneRunner({
      managedRoot: await authority(),
      docker,
      environment,
      ...immediate,
    });

    expect(docker.pullImage).toHaveBeenCalledWith(image);
    expect(docker.pullImage).toHaveBeenCalledOnce();
    expect(docker.startContainer).toHaveBeenCalledWith('created');
  });

  it.each([
    [
      'the failure is not a missing image',
      new DockerError({ kind: 'conflict', message: 'name already in use' }),
      'name already in use',
      true,
    ],
    [
      'the daemon cannot pull at all',
      new DockerError({ kind: 'image_not_found', image, message: 'no such image' }),
      'no such image',
      false,
    ],
  ])('surfaces a create failure when %s', async (_case, error, message, canPull) => {
    const docker = client();
    docker.createContainer.mockRejectedValue(error);

    await expect(
      reconcileManagedControlPlaneRunner({
        managedRoot: await authority(),
        docker: canPull ? docker : withoutCapability(docker, 'pullImage'),
        environment,
        ...immediate,
      }),
    ).rejects.toThrow(message);
    expect(docker.pullImage).not.toHaveBeenCalled();
  });

  it('reports both the startup failure and the predecessor it could not restore', async () => {
    // The worst case: the replacement did not survive AND the Compose Runner it
    // stood down will not come back. An operator told only about the first would
    // go looking for a Runner that is merely unhealthy, not one that is gone.
    const docker = client(
      [
        {
          id: 'legacy',
          imageId: 'sha256:old',
          names: ['verity-verity-control-runner-1'],
          labels: { 'com.docker.compose.service': 'verity-control-runner' },
        },
      ],
      {
        legacy: {
          id: 'legacy',
          running: true,
          image: 'sha256:old',
          mounts: [{ type: 'volume', name: 'verity-control-runner-runtime' }],
        },
      },
    );
    vi.mocked(docker.inspectContainer).mockImplementation(async (id: string) =>
      id === 'created'
        ? { id, running: false, status: 'exited' }
        : {
            id: 'legacy',
            running: true,
            image: 'sha256:old',
            mounts: [{ type: 'volume', name: 'verity-control-runner-runtime' }],
          },
    );
    spy<(id: string) => Promise<void>>(docker.startContainer).mockImplementation(async (id) => {
      if (id === 'legacy') throw new Error('predecessor will not restart');
    });

    const failure: unknown = await reconcileManagedControlPlaneRunner({
      managedRoot: await authority(),
      docker,
      environment,
      ...immediate,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.message).toBe(
      'managed control-plane Runner failed and its predecessor could not be restored',
    );
    expect((aggregate.errors as Error[]).map((entry) => entry.message)).toEqual([
      'managed control-plane Runner exited during startup (exited)',
      'predecessor will not restart',
    ]);
    expect((aggregate.cause as Error).message).toContain('exited during startup');
  });

  it('names the status the daemon gave for a Runner that did not survive startup', async () => {
    const docker = client();
    vi.mocked(docker.inspectContainer).mockImplementation(async (id: string) => ({
      id,
      running: false,
    }));

    await expect(
      reconcileManagedControlPlaneRunner({
        managedRoot: await authority(),
        docker,
        environment,
        ...immediate,
      }),
    ).rejects.toThrow('managed control-plane Runner exited during startup (unknown status)');
  });

  it('lets a newly started Runner settle before believing it came up', async () => {
    // A container that exits on startup is `running` for a moment first, so an
    // immediate inspection reports success for a Runner that is already dead.
    // The default budget is what makes the proof mean anything.
    const docker = client();
    const started = Date.now();

    await reconcileManagedControlPlaneRunner({
      managedRoot: await authority(),
      docker,
      environment,
      socketGid: async () => 986,
    });

    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(docker.startContainer).toHaveBeenCalledWith('created');
  });
});
