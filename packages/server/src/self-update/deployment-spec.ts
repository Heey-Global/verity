import { createHash } from 'node:crypto';
import { posix } from 'node:path';

export const SERVER_DEPLOYMENT_SPEC_VERSION = 2 as const;
const MAX_LINUX_ID = 0xfffffffe;
/** Ceilings for the sealed resource limits. Wide enough for any host Verity is
 *  plausibly installed on, narrow enough that a corrupted or hostile spec cannot
 *  express "effectively unlimited" while still looking like a limit. */
const MAX_MEMORY_BYTES = 1024 ** 4;
const MAX_NANO_CPUS = 1024 * 1_000_000_000;
const MAX_PIDS_LIMIT = 4_194_304;

/** Host resource ceilings for the managed Server container. */
export interface ServerDeploymentSpecResources {
  /** `HostConfig.Memory`. */
  readonly memoryBytes: number;
  /** `HostConfig.MemorySwap`. Equal to {@link memoryBytes} disables swap, which is
   *  what Compose's `memswap_limit` matching its `mem_limit` expresses. */
  readonly memorySwapBytes: number;
  /** `HostConfig.NanoCpus` (1e9 = one core). */
  readonly nanoCpus: number;
  /** `HostConfig.PidsLimit` — the fork-bomb guard. */
  readonly pidsLimit: number;
}

/**
 * What `deploy/docker-compose.yml` gives the `verity` service (`mem_limit: 4g`,
 * `memswap_limit: 4g`, `cpus: 4`, `pids_limit: 512`), and therefore what a
 * managed Server gets when its sealed spec predates {@link
 * ServerDeploymentSpecBody.resources}.
 *
 * The fallback is deliberately identical to what `managed-bootstrap` seals
 * today, so a Server built from an OLD spec and one built from a NEW spec
 * produce the same `HostConfig`. That is what makes the field addable without a
 * schema-version bump: presence changes nothing observable, only who states the
 * value.
 */
export const MANAGED_SERVER_DEFAULT_RESOURCES: ServerDeploymentSpecResources = {
  memoryBytes: 4 * 1024 ** 3,
  memorySwapBytes: 4 * 1024 ** 3,
  nanoCpus: 4_000_000_000,
  pidsLimit: 512,
};

export interface ServerDeploymentSpecBody {
  readonly schemaVersion: typeof SERVER_DEPLOYMENT_SPEC_VERSION;
  readonly deploymentId: string;
  readonly image: string;
  readonly environment: readonly {
    readonly name: string;
    readonly source:
      | { readonly kind: 'env'; readonly name: string }
      | { readonly kind: 'file'; readonly path: string };
  }[];
  readonly mounts: readonly {
    readonly source:
      | { readonly kind: 'volume'; readonly name: string }
      | { readonly kind: 'bind'; readonly path: string };
    readonly target: string;
    readonly readOnly: boolean;
  }[];
  readonly user: {
    readonly uid: number;
    readonly gid: number;
    readonly supplementaryGids: readonly number[];
  };
  readonly restart: 'no' | 'on-failure' | 'unless-stopped';
  readonly network: string;
  readonly platform: { readonly os: 'linux'; readonly architecture: 'amd64' | 'arm64' };
  readonly security: {
    readonly noNewPrivileges: true;
    readonly readOnlyRootFilesystem: boolean;
    readonly capAdd: readonly 'CHOWN'[];
  };
  /**
   * OPTIONAL, for the same reason the Updater control mount is: this spec is
   * sealed once and read by every later Server generation, so requiring a field
   * would make every deployment sealed before it existed unparseable — and an
   * unparseable spec is not a degraded managed Server, it is no managed Server
   * at all, in a crash loop with no path out (`initialize` is create-only).
   *
   * Absent therefore means "the Compose default", not "no limit": see
   * {@link MANAGED_SERVER_DEFAULT_RESOURCES}, which `managedServerContainerSpec`
   * substitutes.
   */
  readonly resources?: ServerDeploymentSpecResources;
}

export interface ServerDeploymentSpec extends ServerDeploymentSpecBody {
  readonly checksum: string;
}

/** Every required key present, every present key required or explicitly optional,
 *  nothing else. `optional` defaults to none, so a two-argument call is exact. */
const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
  optional: readonly string[] = [],
): boolean =>
  Object.getPrototypeOf(value) === Object.prototype &&
  keys.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => keys.includes(key) || optional.includes(key));
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value);
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
const absolutePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.startsWith('/') &&
  !hasControlCharacter(value) &&
  posix.normalize(value) === value;
const uint = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_LINUX_ID;
const bounded = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
const denseArray = (value: unknown): value is unknown[] => {
  if (!Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === value.length && keys.every((key, index) => key === String(index));
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    if (!denseArray(value)) throw new TypeError('deployment spec checksum rejects sparse arrays');
    return `[${value.map(canonical).join(',')}]`;
  }
  if (object(value)) {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError('deployment spec checksum accepts plain JSON objects only');
    }
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  throw new TypeError('deployment spec checksum accepts JSON values only');
}

export function deploymentSpecChecksum(body: ServerDeploymentSpecBody): string {
  return `sha256:${createHash('sha256').update(canonical(body)).digest('hex')}`;
}

export function sealDeploymentSpec(body: ServerDeploymentSpecBody): ServerDeploymentSpec {
  return { ...body, checksum: deploymentSpecChecksum(body) };
}

function parseEnvironment(value: unknown): ServerDeploymentSpecBody['environment'] | null {
  if (!denseArray(value)) return null;
  const parsed: ServerDeploymentSpecBody['environment'][number][] = [];
  for (const entry of value) {
    if (
      !object(entry) ||
      !exactKeys(entry, ['name', 'source']) ||
      !identifier(entry.name) ||
      !object(entry.source)
    )
      return null;
    const source = entry.source;
    if (source.kind === 'env' && exactKeys(source, ['kind', 'name']) && identifier(source.name))
      parsed.push({ name: entry.name, source: { kind: 'env', name: source.name } });
    else if (
      source.kind === 'file' &&
      exactKeys(source, ['kind', 'path']) &&
      absolutePath(source.path) &&
      source.path.startsWith('/run/secrets/')
    )
      parsed.push({ name: entry.name, source: { kind: 'file', path: source.path } });
    else return null;
  }
  return parsed;
}

/**
 * Resource limits out of a candidate spec.
 *
 * Returns `{}` for a spec sealed before the field existed and `null` for one
 * whose value is not a limit this deployment accepts. Keeping those two apart is
 * the entire compatibility contract — collapsing "absent" into "rejected" would
 * brick every deployment sealed by an earlier Server.
 *
 * Absent stays absent in the reconstructed body: the checksum is computed over
 * that body and compared against the sealed one, so substituting a default here
 * would change the hash input and make every old spec fail its own seal.
 */
function parseResources(
  value: Record<string, unknown>,
): { readonly resources?: ServerDeploymentSpecResources } | null {
  if (!Object.hasOwn(value, 'resources')) return {};
  const resources = value.resources;
  if (
    !object(resources) ||
    !exactKeys(resources, ['memoryBytes', 'memorySwapBytes', 'nanoCpus', 'pidsLimit']) ||
    !bounded(resources.memoryBytes, MAX_MEMORY_BYTES) ||
    !bounded(resources.memorySwapBytes, MAX_MEMORY_BYTES) ||
    !bounded(resources.nanoCpus, MAX_NANO_CPUS) ||
    !bounded(resources.pidsLimit, MAX_PIDS_LIMIT) ||
    // A combined memory+swap ceiling below the memory ceiling is what Docker
    // rejects as invalid, and it would make the memory limit unreachable anyway.
    resources.memorySwapBytes < resources.memoryBytes
  )
    return null;
  return {
    resources: {
      memoryBytes: resources.memoryBytes,
      memorySwapBytes: resources.memorySwapBytes,
      nanoCpus: resources.nanoCpus,
      pidsLimit: resources.pidsLimit,
    },
  };
}

export function parseServerDeploymentSpec(value: unknown): ServerDeploymentSpec | null {
  if (
    !object(value) ||
    !exactKeys(
      value,
      [
        'schemaVersion',
        'deploymentId',
        'image',
        'environment',
        'mounts',
        'user',
        'restart',
        'network',
        'platform',
        'security',
        'checksum',
      ],
      ['resources'],
    )
  )
    return null;
  if (value.schemaVersion !== SERVER_DEPLOYMENT_SPEC_VERSION || !identifier(value.deploymentId))
    return null;
  if (
    typeof value.image !== 'string' ||
    !/^ghcr\.io\/heey-global\/verity\/verity-server@sha256:[a-f0-9]{64}$/.test(value.image)
  )
    return null;
  const environment = parseEnvironment(value.environment);
  if (environment === null || !denseArray(value.mounts)) return null;
  const mounts: ServerDeploymentSpecBody['mounts'][number][] = [];
  for (const mount of value.mounts) {
    if (
      !object(mount) ||
      !exactKeys(mount, ['source', 'target', 'readOnly']) ||
      !object(mount.source) ||
      typeof mount.readOnly !== 'boolean'
    )
      return null;
    const source = mount.source;
    if (
      source.kind === 'volume' &&
      exactKeys(source, ['kind', 'name']) &&
      ((source.name === 'verity-data' && mount.target === '/srv/verity') ||
        (source.name === 'verity-agent-gateway-control' &&
          mount.target === '/run/verity-agent-gateway') ||
        (source.name === 'verity-updater-control' &&
          mount.target === '/run/verity-updater/control') ||
        (source.name === 'verity-control-runner-runtime' &&
          mount.target === '/srv/verity/runners/verity-control') ||
        (source.name === 'verity-control-runner-identity' &&
          mount.target === '/run/verity-control-identity'))
    ) {
      mounts.push({
        source: { kind: 'volume', name: source.name },
        target: mount.target,
        readOnly: mount.readOnly,
      });
    } else if (
      source.kind === 'bind' &&
      exactKeys(source, ['kind', 'path']) &&
      absolutePath(source.path) &&
      ((posix.basename(source.path) === 'docker.sock' &&
        mount.target === '/var/run/docker.sock' &&
        !mount.readOnly) ||
        (mount.target === '/run/verity-pairing' && mount.readOnly))
    ) {
      mounts.push({
        source: { kind: 'bind', path: source.path },
        target: mount.target,
        readOnly: mount.readOnly,
      });
    } else return null;
  }
  const mountKeys = mounts.map((mount) =>
    mount.source.kind === 'volume'
      ? `volume:${mount.source.name}:${mount.target}`
      : `bind:${mount.source.path}:${mount.target}`,
  );
  const requiredVolumeKeys = [
    'volume:verity-data:/srv/verity',
    'volume:verity-agent-gateway-control:/run/verity-agent-gateway',
  ];
  const controlRunnerVolumeKeys = [
    'volume:verity-control-runner-runtime:/srv/verity/runners/verity-control',
    'volume:verity-control-runner-identity:/run/verity-control-identity',
  ];
  // The Updater control mount is OPTIONAL, deliberately. Requiring it would make
  // every deployment sealed before it existed unparseable, and `initialize` is
  // create-only — such a deployment could not re-seal itself and its Updater
  // would refuse to start. Optional costs nothing in authority: the allowlist
  // above still pins which volume may appear at which target, and the Server
  // builds its update controller only when the socket is actually there.
  if (
    mounts.length < 3 ||
    mounts.length > 7 ||
    mounts.some((mount) => mount.readOnly !== (mount.target === '/run/verity-pairing')) ||
    new Set(mountKeys).size !== mountKeys.length ||
    // Distinct targets, not just distinct keys: two binds from different host
    // paths onto /var/run/docker.sock produce different keys, and with a fourth
    // slot now available one of them could shadow the socket the allowlist
    // vetted.
    new Set(mounts.map((mount) => mount.target)).size !== mounts.length ||
    !requiredVolumeKeys.every((key) => mountKeys.includes(key)) ||
    // The two control-plane volumes form one boundary: the Server must rotate the
    // identity generation it asks the Runner to acknowledge over the matching
    // runtime socket. Accept old specs with neither, but never a half-upgraded pair.
    controlRunnerVolumeKeys.some((key) => mountKeys.includes(key)) !==
      controlRunnerVolumeKeys.every((key) => mountKeys.includes(key)) ||
    !mounts.some((mount) => mount.source.kind === 'bind' && mount.target === '/var/run/docker.sock')
  )
    return null;
  const user = value.user;
  if (
    !object(user) ||
    !exactKeys(user, ['uid', 'gid', 'supplementaryGids']) ||
    !uint(user.uid) ||
    !uint(user.gid) ||
    !denseArray(user.supplementaryGids) ||
    !user.supplementaryGids.every(uint)
  )
    return null;
  if (
    value.restart !== 'no' &&
    value.restart !== 'on-failure' &&
    value.restart !== 'unless-stopped'
  )
    return null;
  const platform = value.platform;
  if (
    !object(platform) ||
    !exactKeys(platform, ['os', 'architecture']) ||
    platform.os !== 'linux' ||
    (platform.architecture !== 'amd64' && platform.architecture !== 'arm64')
  )
    return null;
  const security = value.security;
  if (
    !object(security) ||
    !exactKeys(security, ['noNewPrivileges', 'readOnlyRootFilesystem', 'capAdd']) ||
    security.noNewPrivileges !== true ||
    typeof security.readOnlyRootFilesystem !== 'boolean' ||
    !denseArray(security.capAdd) ||
    !security.capAdd.every((cap) => cap === 'CHOWN')
  )
    return null;
  if (value.network !== 'verity-net' || typeof value.checksum !== 'string') return null;
  const resources = parseResources(value);
  if (resources === null) return null;
  const body: ServerDeploymentSpecBody = {
    schemaVersion: 2,
    deploymentId: value.deploymentId,
    image: value.image,
    environment,
    mounts,
    user: { uid: user.uid, gid: user.gid, supplementaryGids: user.supplementaryGids },
    restart: value.restart,
    network: value.network,
    platform: { os: 'linux', architecture: platform.architecture },
    security: {
      noNewPrivileges: true,
      readOnlyRootFilesystem: security.readOnlyRootFilesystem,
      capAdd: security.capAdd,
    },
    ...resources,
  };
  return value.checksum === deploymentSpecChecksum(body)
    ? { ...body, checksum: value.checksum }
    : null;
}
