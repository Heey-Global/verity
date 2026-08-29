import { userInfo } from 'node:os';
import { basename, isAbsolute, normalize } from 'node:path';
import { ACTIVATION_GATE_DIRECTORY } from './activation-gate.js';
import {
  MANAGED_SERVER_DEFAULT_RESOURCES,
  type ServerDeploymentSpecBody,
} from './deployment-spec.js';
import { initializeManagedDeployment } from './managed-deployment.js';

const OFFICIAL_IMAGE = /^ghcr\.io\/heey-global\/verity\/verity-server@sha256:[a-f0-9]{64}$/;
const MAX_LINUX_ID = 0xfffffffe;
export const MANAGED_DEPLOYMENT_ROOT = '/var/lib/verity/updater/managed-deployment';
const REQUIRED_SERVER_ENVIRONMENT = [
  'HOST',
  'DATABASE_URL',
  'VERITY_DOCKER_BASE_URL',
  'VERITY_ROOT',
  'VERITY_DATA_VOLUME',
  'VERITY_REPO_DIR',
  'VERITY_MANAGED_DEPLOYMENT_ID',
  'VERITY_DOCKER_SOCKET_PATH',
] as const;

export interface ManagedBootstrapEnvironment {
  readonly [name: string]: string | undefined;
  readonly VERITY_MANAGED_ROOT?: string;
  readonly VERITY_SERVER_IMAGE?: string;
  readonly VERITY_MANAGED_DEPLOYMENT_ID?: string;
  readonly VERITY_SERVER_UID?: string;
  readonly VERITY_SERVER_GID?: string;
  readonly VERITY_DOCKER_SOCKET_GID?: string;
  readonly VERITY_PROJECT_RELAY_GID?: string;
  readonly VERITY_RUNNER_RUNTIME_GID?: string;
  readonly VERITY_HOST_ARCHITECTURE?: string;
}

function uint(name: string, value: string | undefined, fallback: number): number {
  if (value !== undefined && !/^\d+$/.test(value))
    throw new Error(`${name} must be canonical decimal digits`);
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_LINUX_ID)
    throw new Error(`${name} must be a supported Linux user or group ID`);
  return parsed;
}

export async function runManagedBootstrap(
  env: ManagedBootstrapEnvironment,
  hostArchitecture: string = env.VERITY_HOST_ARCHITECTURE ?? '',
  expectedRoot: string = MANAGED_DEPLOYMENT_ROOT,
): Promise<void> {
  const root = env.VERITY_MANAGED_ROOT;
  if (
    root === undefined ||
    !isAbsolute(root) ||
    normalize(root) !== root ||
    root === '/' ||
    basename(root) !== 'managed-deployment' ||
    root !== expectedRoot
  )
    throw new Error(
      'VERITY_MANAGED_ROOT must be a normalized updater-owned managed-deployment directory',
    );
  const image = env.VERITY_SERVER_IMAGE;
  if (image === undefined || !OFFICIAL_IMAGE.test(image))
    throw new Error('VERITY_SERVER_IMAGE must be the official digest-pinned Server image');
  if (env.VERITY_MANAGED_DEPLOYMENT_ID === undefined)
    throw new Error('VERITY_MANAGED_DEPLOYMENT_ID is required for managed bootstrap');
  const architecture = hostArchitecture === 'x64' ? 'amd64' : hostArchitecture;
  if (architecture !== 'amd64' && architecture !== 'arm64')
    throw new Error(`unsupported host architecture: ${hostArchitecture}`);
  const currentUser = userInfo();
  const uid = uint('VERITY_SERVER_UID', env.VERITY_SERVER_UID, currentUser.uid);
  const gid = uint('VERITY_SERVER_GID', env.VERITY_SERVER_GID, currentUser.gid);
  const dockerGid = uint('VERITY_DOCKER_SOCKET_GID', env.VERITY_DOCKER_SOCKET_GID, 999);
  const relayGid = uint('VERITY_PROJECT_RELAY_GID', env.VERITY_PROJECT_RELAY_GID, 65532);
  const runnerGid = uint('VERITY_RUNNER_RUNTIME_GID', env.VERITY_RUNNER_RUNTIME_GID, 1101);
  for (const name of REQUIRED_SERVER_ENVIRONMENT) {
    if (env[name] === undefined)
      throw new Error(`${name} is required to reconstruct the managed Server`);
  }
  const dockerSocketPath = env.VERITY_DOCKER_SOCKET_PATH;
  if (dockerSocketPath === undefined)
    throw new Error('VERITY_DOCKER_SOCKET_PATH is required to reconstruct the managed Server');
  if (env.VERITY_DATA_VOLUME !== 'verity-data')
    throw new Error('VERITY_DATA_VOLUME must be verity-data for managed bootstrap');
  if (env.VERITY_ROOT !== '/srv/verity')
    throw new Error('VERITY_ROOT must be /srv/verity for managed bootstrap');
  if (env.VERITY_DOCKER_BASE_URL !== 'unix:///var/run/docker.sock')
    throw new Error('VERITY_DOCKER_BASE_URL must use the managed /var/run/docker.sock endpoint');
  const forwardedEnvironment = Object.keys(env)
    .filter(
      (name) =>
        name === 'HOST' ||
        name === 'DATABASE_URL' ||
        name === 'EXPO_ACCESS_TOKEN' ||
        name === 'GOOGLE_AUTH_ID' ||
        (name.startsWith('VERITY_') &&
          // Bootstrap INPUTS, not Server runtime environment. Each of these shapes
          // the spec — the image, the uid/gid the container runs as, the groups it
          // joins — and is consumed here rather than passed on. Forwarding one makes
          // it an env source the Updater must resolve on every reconcile, forever,
          // and the Updater's Compose service is not where these are set.
          //
          // VERITY_RUNNER_RUNTIME_GID is intentionally forwarded: ACP-only Claude
          // uses it for the control-plane identity volume as well as project Runner
          // runtimes. The Updater carries the same source on every reconciliation.
          ![
            // Baked into every Server image, which is the entire point of it: a
            // release publishes the relay that matches it. Forwarding it makes the
            // Updater resolve it on every reconcile — from ITS OWN image, and the
            // Updater replaces itself during an update. From the next release on,
            // its copy therefore names a different relay than the promoted Server
            // was created with, and the two can never agree again. Left out, each
            // Server simply uses what its own image carries.
            'VERITY_BUNDLED_PROJECT_RELAY_IMAGE',
            'VERITY_MANAGED_ROOT',
            'VERITY_SERVER_IMAGE',
            'VERITY_SERVER_UID',
            'VERITY_SERVER_GID',
            'VERITY_DOCKER_SOCKET_GID',
            'VERITY_HOST_ARCHITECTURE',
          ].includes(name)),
    )
    .sort()
    .map((name) => ({ name, source: { kind: 'env' as const, name } }));
  const spec: Omit<ServerDeploymentSpecBody, 'schemaVersion' | 'deploymentId'> = {
    image,
    environment: forwardedEnvironment,
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
        // Read-write because connecting to a unix socket needs write permission
        // on the socket inode. The Updater owns the volume and sets it to mode
        // 0750 root:<server gid>, so the Server can connect to the socket and
        // read the token but can replace neither.
        source: { kind: 'volume', name: 'verity-updater-control' },
        target: ACTIVATION_GATE_DIRECTORY,
        readOnly: false,
      },
      {
        source: { kind: 'bind', path: dockerSocketPath },
        target: '/var/run/docker.sock',
        readOnly: false,
      },
      ...(env.VERITY_RUNNER_SUPERVISOR === '1'
        ? [
            {
              source: { kind: 'volume' as const, name: 'verity-control-runner-runtime' },
              target: '/srv/verity/runners/verity-control',
              readOnly: false,
            },
            {
              source: { kind: 'volume' as const, name: 'verity-control-runner-identity' },
              target: '/run/verity-control-identity',
              readOnly: false,
            },
          ]
        : []),
    ],
    user: { uid, gid, supplementaryGids: [...new Set([dockerGid, relayGid, runnerGid])] },
    restart: 'unless-stopped',
    network: 'verity-net',
    platform: { os: 'linux', architecture },
    security: {
      noNewPrivileges: true,
      readOnlyRootFilesystem: false,
      capAdd: env.VERITY_RUNNER_SUPERVISOR === '1' ? ['CHOWN'] : [],
    },
    // The host guardrails Compose gives the `verity` service, stated by the
    // authority that now owns the container instead of by Compose. Sealed here
    // and only here: an already-adopted deployment is never given the field
    // retroactively (see `advanceManagedDeploymentImage`), because an old spec
    // already resolves to these same values.
    resources: MANAGED_SERVER_DEFAULT_RESOURCES,
  };
  const state = await initializeManagedDeployment({
    root,
    spec,
    deploymentId: env.VERITY_MANAGED_DEPLOYMENT_ID,
  });
  if (!state.managed) throw new Error(state.reason);
  if (state.spec.image !== image)
    throw new Error('VERITY_SERVER_IMAGE does not match the sealed managed deployment image');
}
