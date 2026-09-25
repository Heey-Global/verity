import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContainerSpec, DockerClient } from '../docker.js';
import { readManagedDeployment } from './managed-deployment.js';
import { MANAGED_DEPLOYMENT_LABEL, MANAGED_ROLE_LABEL } from './managed-server-owner.js';

export const MANAGED_MATRIX_CONNECTOR_NAME = 'verity-managed-matrix-connector';
const INIT_NAME = 'verity-managed-matrix-connector-init';
const ROLE = 'matrix-connector';
const INIT_ROLE = 'matrix-connector-init';
const IMAGE_ENV = 'VERITY_BUNDLED_MATRIX_CONNECTOR_IMAGE';
const IMAGE_PATTERN =
  /^ghcr\.io\/heey-global\/verity\/verity-matrix-connector@sha256:[a-f0-9]{64}$/;
const PREPARATION_TIMEOUT_MS = 120_000;
const ENABLE_MARKER = 'matrix-connector-enabled';

async function privateRoot(root: string) {
  const directory = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const metadata = await directory.stat();
  if (
    !metadata.isDirectory() ||
    metadata.uid !== process.geteuid?.() ||
    (metadata.mode & 0o077) !== 0
  ) {
    await directory.close();
    throw new Error('managed Matrix connector root must be a private updater-owned directory');
  }
  return directory;
}

async function markerEnabled(root: string): Promise<boolean> {
  const directory = await privateRoot(root);
  try {
    const path = join(`/proc/self/fd/${directory.fd}`, ENABLE_MARKER);
    let marker;
    try {
      marker = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    try {
      const metadata = await marker.stat();
      if (
        !metadata.isFile() ||
        metadata.uid !== process.geteuid?.() ||
        (metadata.mode & 0o077) !== 0 ||
        (await marker.readFile('utf8')) !== 'enabled\n'
      )
        throw new Error('managed Matrix connector enable marker is invalid');
      return true;
    } finally {
      await marker.close();
    }
  } finally {
    await directory.close();
  }
}

/** Persist the decision to start Matrix after a complete account was saved. */
export async function enableManagedMatrixConnector(managedRoot: string): Promise<void> {
  const deployment = await readManagedDeployment(managedRoot);
  if (!deployment.managed) throw new Error('managed deployment is unavailable');
  if (await markerEnabled(managedRoot)) return;
  const directory = await privateRoot(managedRoot);
  const root = `/proc/self/fd/${directory.fd}`;
  const temporary = join(root, `${ENABLE_MARKER}.${randomUUID()}.tmp`);
  try {
    const marker = await open(temporary, 'wx', 0o600);
    try {
      await marker.writeFile('enabled\n');
      await marker.sync();
    } finally {
      await marker.close();
    }
    try {
      await link(temporary, join(root, ENABLE_MARKER));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!(await markerEnabled(managedRoot)))
        throw new Error('managed Matrix connector enable marker was not safely created', {
          cause: error,
        });
    }
    await directory.sync();
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    await directory.close();
  }
}

export type ManagedMatrixConnectorDocker = Pick<
  DockerClient,
  | 'createContainer'
  | 'inspectContainer'
  | 'inspectImageEnv'
  | 'listContainers'
  | 'pullImage'
  | 'removeContainer'
  | 'startContainer'
  | 'stopContainer'
  | 'waitContainer'
>;

export interface ReconcileManagedMatrixConnectorOptions {
  readonly managedRoot: string;
  readonly docker: ManagedMatrixConnectorDocker;
  readonly preparationTimeoutMs?: number;
}

const missing = (error: unknown): boolean =>
  (error as { kind?: unknown }).kind === 'container_not_found';

async function remove(docker: ManagedMatrixConnectorDocker, id: string): Promise<void> {
  try {
    await docker.stopContainer(id);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  try {
    await docker.removeContainer(id);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

async function create(docker: ManagedMatrixConnectorDocker, spec: ContainerSpec): Promise<string> {
  try {
    return (await docker.createContainer(spec)).id;
  } catch (error) {
    if ((error as { kind?: unknown }).kind !== 'image_not_found' || !docker.pullImage) throw error;
    await docker.pullImage(spec.image);
    return (await docker.createContainer(spec)).id;
  }
}

const prepareScript = String.raw`
const { randomBytes } = require('node:crypto');
const { mkdirSync, openSync, writeSync, closeSync, chmodSync, chownSync, readFileSync, lstatSync, linkSync, unlinkSync, fsyncSync } = require('node:fs');
const directory = '/control/matrix';
const gid = Number(process.argv[1]);
mkdirSync(directory, { recursive: true, mode: 0o750 });
const directoryMetadata = lstatSync(directory);
if (!directoryMetadata.isDirectory() || directoryMetadata.uid !== 0)
  throw new Error('unsafe Matrix connector secret directory');
chownSync(directory, 0, gid);
chmodSync(directory, 0o750);
for (const name of ['connector-token', 'store-passphrase']) {
  const path = directory + '/' + name;
  const temporary = directory + '/.' + name + '.' + randomBytes(12).toString('hex');
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeSync(fd, randomBytes(48).toString('hex') + '\n');
      chownSync(temporary, 0, gid);
      chmodSync(temporary, 0o640);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    try { linkSync(temporary, path); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally {
    unlinkSync(temporary);
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.uid !== 0 || metadata.gid !== gid || (metadata.mode & 0o777) !== 0o640)
    throw new Error('unsafe Matrix connector secret file: ' + name);
  if (!/^[a-f0-9]{96}\n$/.test(readFileSync(path, 'utf8')))
    throw new Error('invalid Matrix connector secret file: ' + name);
}
mkdirSync('/data', { recursive: true });
chownSync('/data', 10001, 10001);
chmodSync('/data', 0o700);
`;

function initSpec(
  serverImage: string,
  deploymentId: string,
  architecture: 'amd64' | 'arm64',
  serverGid: number,
): ContainerSpec {
  return {
    image: serverImage,
    name: INIT_NAME,
    labels: { [MANAGED_DEPLOYMENT_LABEL]: deploymentId, [MANAGED_ROLE_LABEL]: INIT_ROLE },
    entrypoint: ['node', '-e', prepareScript, String(serverGid)],
    user: 'root',
    volumeMounts: [
      { volume: 'verity-updater-control', target: '/control' },
      { volume: 'verity-matrix-connector-data', target: '/data' },
    ],
    restartPolicy: 'no',
    platform: `linux/${architecture}`,
    securityOpt: ['no-new-privileges:true'],
  };
}

export function managedMatrixConnectorSpec(
  image: string,
  deploymentId: string,
  architecture: 'amd64' | 'arm64',
  serverGid: number,
): ContainerSpec {
  if (!IMAGE_PATTERN.test(image))
    throw new Error('Matrix connector image is not an official digest');
  return {
    image,
    name: MANAGED_MATRIX_CONNECTOR_NAME,
    labels: { [MANAGED_DEPLOYMENT_LABEL]: deploymentId, [MANAGED_ROLE_LABEL]: ROLE },
    user: '10001:10001',
    groupAdd: [String(serverGid)],
    env: [
      'MATRIX_DATA_DIR=/data',
      'VERITY_INTERNAL_URL=http://verity:8083',
      'VERITY_MATRIX_CONNECTOR_TOKEN_FILE=/run/verity-matrix/connector-token',
      'MATRIX_STORE_PASSPHRASE_FILE=/run/verity-matrix/store-passphrase',
    ],
    volumeMounts: [
      {
        volume: 'verity-updater-control',
        target: '/run/verity-matrix',
        subpath: 'matrix',
        readOnly: true,
      },
      { volume: 'verity-matrix-connector-data', target: '/data' },
    ],
    restartPolicy: 'unless-stopped',
    network: 'verity-net',
    platform: `linux/${architecture}`,
    capDrop: ['ALL'],
    securityOpt: ['no-new-privileges:true'],
    pidsLimit: 128,
    memoryBytes: 1024 ** 3,
    memorySwapBytes: 1024 ** 3,
    nanoCpus: 1_000_000_000,
  };
}

async function prepare(
  options: ReconcileManagedMatrixConnectorOptions,
  spec: ContainerSpec,
): Promise<void> {
  const { docker } = options;
  if (!docker.listContainers || !docker.waitContainer)
    throw new Error('managed Matrix connector preparation requires container listing and wait');
  const previous = (await docker.listContainers()).filter((item) =>
    item.names?.includes(INIT_NAME),
  );
  if (previous.length > 1) throw new Error('multiple containers use the Matrix init name');
  for (const item of previous) {
    const current = await docker.inspectContainer(item.id);
    if (
      current.labels?.[MANAGED_DEPLOYMENT_LABEL] !== spec.labels?.[MANAGED_DEPLOYMENT_LABEL] ||
      current.labels?.[MANAGED_ROLE_LABEL] !== INIT_ROLE
    )
      throw new Error('Matrix init name is occupied by a foreign container');
    await remove(docker, item.id);
  }
  const id = await create(docker, spec);
  try {
    await docker.startContainer(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exit = await Promise.race([
      docker.waitContainer(id),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(
          () => resolve('timeout'),
          options.preparationTimeoutMs ?? PREPARATION_TIMEOUT_MS,
        );
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (exit !== 0)
      throw new Error(
        `Matrix connector preparation ${exit === 'timeout' ? 'timed out' : `exited ${String(exit)}`}`,
      );
  } finally {
    await remove(docker, id);
  }
}

/** Reconcile the worker only after the managed Server has been promoted. */
export async function reconcileManagedMatrixConnector(
  options: ReconcileManagedMatrixConnectorOptions,
): Promise<void> {
  const deployment = await readManagedDeployment(options.managedRoot);
  if (!deployment.managed) return;
  const { spec } = deployment;
  const enabled = await markerEnabled(options.managedRoot);
  const imageEnv = enabled ? await options.docker.inspectImageEnv?.(spec.image) : undefined;
  if (enabled && !imageEnv)
    throw new Error('managed Matrix connector requires Server image inspection');
  const image = imageEnv
    ?.find((entry) => entry.startsWith(`${IMAGE_ENV}=`))
    ?.slice(IMAGE_ENV.length + 1);
  if (!options.docker.listContainers)
    throw new Error('managed Matrix connector requires container listing');
  // A rollback to an older release must also stop a worker left by a newer one.
  if (!image) {
    const named = (await options.docker.listContainers()).filter((item) =>
      item.names?.includes(MANAGED_MATRIX_CONNECTOR_NAME),
    );
    for (const item of named) {
      const current = await options.docker.inspectContainer(item.id);
      if (
        current.labels?.[MANAGED_DEPLOYMENT_LABEL] !== spec.deploymentId ||
        current.labels?.[MANAGED_ROLE_LABEL] !== ROLE
      )
        throw new Error('managed Matrix connector name is occupied by a foreign container');
      await remove(options.docker, item.id);
    }
    return;
  }
  if (!IMAGE_PATTERN.test(image))
    throw new Error('Matrix connector image is not an official digest');
  const desired = managedMatrixConnectorSpec(
    image,
    spec.deploymentId,
    spec.platform.architecture,
    spec.user.gid,
  );
  await prepare(
    options,
    initSpec(spec.image, spec.deploymentId, spec.platform.architecture, spec.user.gid),
  );
  if (!options.docker.listContainers)
    throw new Error('managed Matrix connector requires container listing');
  const named = (await options.docker.listContainers()).filter((item) =>
    item.names?.includes(MANAGED_MATRIX_CONNECTOR_NAME),
  );
  if (named.length > 1)
    throw new Error('multiple containers use the managed Matrix connector name');
  if (named.length === 1) {
    const current = await options.docker.inspectContainer(named[0]!.id);
    if (
      current.labels?.[MANAGED_DEPLOYMENT_LABEL] !== spec.deploymentId ||
      current.labels?.[MANAGED_ROLE_LABEL] !== ROLE
    )
      throw new Error('managed Matrix connector name is occupied by a foreign container');
    if (
      current.image === image &&
      current.running &&
      current.networkMode === desired.network &&
      current.user === desired.user &&
      current.groupAdd?.includes(String(spec.user.gid)) === true &&
      desired.env?.every((entry) => current.env?.includes(entry)) === true &&
      desired.volumeMounts?.every((mount) =>
        current.mounts?.some(
          (actual) =>
            actual.type === 'volume' &&
            actual.name === mount.volume &&
            actual.destination === mount.target &&
            actual.readWrite === (mount.readOnly !== true),
        ),
      ) === true
    )
      return;
    await remove(options.docker, current.id);
  }
  const id = await create(options.docker, desired);
  try {
    await options.docker.startContainer(id);
  } catch (error) {
    await remove(options.docker, id);
    throw error;
  }
}
