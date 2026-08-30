/**
 * Shared fixture for the managed self-update tests: a stateful stand-in for the
 * Docker Engine, plus the sealed deployment those tests act on.
 *
 * It lives outside the test files because preparation, cutover, and the runner
 * all depend on the SAME daemon semantics — names are unique, ids are minted,
 * removal really removes — and a per-file copy would let those semantics drift
 * apart while every file still passed.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { DockerError, type ContainerInspect, type ContainerSpec } from '../docker.js';
import type { ServerDeploymentSpecBody } from './deployment-spec.js';
import type { StandbyPromotionDocker } from './docker-in-place-cutover.js';
import type { UpdatePreparationDocker } from './docker-update-preparation.js';
import { initializeManagedDeployment } from './managed-deployment.js';
import { reconcileManagedServer } from './managed-server-owner.js';

export const DEPLOYMENT_ID = 'deployment-1';
export const oldImage = `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`;
export const newImage = `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`;
export const ENVIRONMENT = { DATABASE_URL: 'postgres://db', DEPLOYMENT_ID };
/** What the official image bakes in, including the version the Updater's own
 *  offline attestation reads back off the pulled image. */
export const IMAGE_ENV = [
  'PATH=/usr/local/bin:/usr/bin:/bin',
  'PORT=8082',
  'VERITY_ROOT=/srv/verity',
  'VERITY_SERVER_VERSION=10.6.0',
];

export const sealedSpec = (): Omit<ServerDeploymentSpecBody, 'schemaVersion' | 'deploymentId'> => ({
  image: oldImage,
  environment: [
    { name: 'DATABASE_URL', source: { kind: 'env', name: 'DATABASE_URL' } },
    { name: 'VERITY_MANAGED_DEPLOYMENT_ID', source: { kind: 'env', name: 'DEPLOYMENT_ID' } },
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
});

/** What a daemon reports for a container created from `spec`: the image's baked
 *  environment with the create request applied on top, and volume mounts
 *  carrying both the volume name and the host path it resolves to. */
export function inspectFromSpec(id: string, spec: ContainerSpec, status: string): ContainerInspect {
  const env = new Map<string, string>();
  for (const entry of [...IMAGE_ENV, ...(spec.env ?? [])])
    env.set(entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1));
  return {
    id,
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

export type FakeDaemon = ReturnType<typeof fakeDaemon>;

/**
 * A stateful stand-in for the Engine. The self-update executors' whole
 * correctness argument is about container lifetime under crash and retry, which
 * per-call mocks cannot express.
 */
export function fakeDaemon() {
  const containers = new Map<string, { spec: ContainerSpec; status: string }>();
  const exitCodes = new Map<string, number>();
  const logs = new Map<string, string>();
  let minted = 0;
  const find = (name: string): string | undefined =>
    [...containers].find(([, container]) => container.spec.name === name)?.[0];
  const get = (id: string) => {
    const container = containers.get(id);
    if (container === undefined) throw new DockerError({ kind: 'container_not_found', id });
    return container;
  };
  const docker: StandbyPromotionDocker & UpdatePreparationDocker = {
    listContainers: vi.fn(async () =>
      Promise.resolve(
        [...containers].map(([id, container]) => ({
          id,
          imageId: `sha256:${container.spec.image.slice(-64)}`,
          names: [container.spec.name],
        })),
      ),
    ),
    createContainer: vi.fn(async (spec: ContainerSpec) => {
      if (find(spec.name) !== undefined)
        throw new DockerError({ kind: 'conflict', message: 'name in use' });
      minted += 1;
      const id = minted.toString(16).padStart(64, '0');
      containers.set(id, { spec, status: 'created' });
      return Promise.resolve({ id, warnings: [] });
    }),
    inspectContainer: vi.fn(async (id: string) => {
      const container = get(id);
      return Promise.resolve(inspectFromSpec(id, container.spec, container.status));
    }),
    startContainer: vi.fn(async (id: string) => {
      get(id).status = 'running';
      return Promise.resolve();
    }),
    stopContainer: vi.fn(async (id: string) => {
      get(id).status = 'exited';
      return Promise.resolve();
    }),
    removeContainer: vi.fn(async (id: string) => {
      get(id);
      containers.delete(id);
      return Promise.resolve();
    }),
    waitContainer: vi.fn(async (id: string) => {
      const container = get(id);
      container.status = 'exited';
      return Promise.resolve(exitCodes.get(container.spec.name) ?? 0);
    }),
    containerLogs: vi.fn(async (id: string) => Promise.resolve(logs.get(get(id).spec.name) ?? '')),
    pullImage: vi.fn(async () => Promise.resolve()),
    inspectImageEnv: vi.fn(async () => Promise.resolve(IMAGE_ENV)),
  };
  return {
    docker,
    exitCodes,
    logs,
    find,
    names: () => [...containers.values()].map((container) => container.spec.name).sort(),
    spec: (name: string) => containers.get(find(name)!)?.spec,
    status: (name: string) => containers.get(find(name)!)?.status,
  };
}

/** An adopted deployment serving the old digest — the state every update starts
 *  from. `prefix` only names the temporary directory. */
export async function adoptedDeployment(
  prefix: string,
): Promise<{ root: string; daemon: FakeDaemon; oldContainerId: string }> {
  const root = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const daemon = fakeDaemon();
  await initializeManagedDeployment({ root, deploymentId: DEPLOYMENT_ID, spec: sealedSpec() });
  const old = await reconcileManagedServer({
    managedRoot: root,
    docker: daemon.docker,
    environment: ENVIRONMENT,
  });
  return { root, daemon, oldContainerId: old.containerId };
}
