import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DockerClient } from '../docker.js';
import type { RuntimeServiceRequirements } from './host-runtime-renewal.js';

/**
 * Docker runtime registrations a Server release needs on its host (ADR 0008 Amendment 2).
 *
 * Project Sandboxes run under `runsc-project` and Secret jobs under `runsc` — two registrations
 * of one pinned gVisor binary in the HOST's /etc/docker/daemon.json. The Updater cannot write
 * that file or reload dockerd (it is a container with the Docker socket, nothing more), and an
 * update that activated a release on a host lacking them left every project unable to run a
 * turn (v1.5.2: "the project supervisor socket is missing"). The readiness probe cannot catch
 * it either: it accepts a `degraded` 503 on purpose.
 *
 * So a release DECLARES what it needs, as an OCI label on its image — read off the pulled,
 * digest-verified target and never entering any container's environment, like
 * `org.verity.postgres-image`. Before the standby is created, the Updater compares that with
 * what dockerd reports (`GET /info`, read-only). When they differ it asks the host component
 * `verity-host-runtime` — installed by `verity-install`, triggered by a systemd path unit — to
 * reconcile, waits for its answer, and verifies again. Anything short of a verified match fails
 * the operation before activation, and the current generation keeps serving.
 */
export const HOST_RUNTIMES_LABEL = 'org.verity.host-runtimes';

/** Where the Updater container sees the host's `/var/lib/verity/host-runtime`. */
const HOST_RUNTIME_REQUEST_DIR = '/run/verity-host-runtime';

const HOST_RUNTIME_NAMES = ['runsc', 'runsc-project'] as const;
type HostRuntimeName = (typeof HOST_RUNTIME_NAMES)[number];

/**
 * The only arguments a declared runtime may carry. The host component enforces the same set,
 * so a release cannot ask the root process for a flag it does not know; this copy only makes
 * the Updater refuse such a release itself, with a message, instead of waiting for a refusal.
 */
export const HOST_RUNTIME_ALLOWED_ARGS = [
  '--platform=systrap',
  '--network=none',
  '--network=sandbox',
  '--host-uds=create',
] as const;

interface ArchitectureSums {
  readonly x86_64: string;
  readonly aarch64: string;
}

export interface HostRuntimeRequirements {
  readonly release: string;
  /** The runsc binary, per architecture. */
  readonly sha512: ArchitectureSums;
  /**
   * Present for a gVisor release that ships as `gvisor.tar.bz2` (runsc plus the sidecars in
   * `gvisor-bin/` it cannot start a sandbox without) rather than as a single binary. Only a host
   * component that advertises `archive` in agent.json can install one; an older one would
   * refuse the shape, which is also why an older Updater refuses a release declaring it.
   */
  readonly archiveSha512?: ArchitectureSums;
  readonly runtimes: Readonly<Record<HostRuntimeName, readonly string[]>>;
}

export class HostRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostRuntimeError';
  }
}

const REPAIR =
  'Re-run the Verity installer once on the host (it installs the host runtime service and ' +
  'registers the runtimes), then retry the update.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

function isArchitectureSums(value: unknown): value is ArchitectureSums {
  return (
    isRecord(value) &&
    exactKeys(value, ['x86_64', 'aarch64']) &&
    Object.values(value).every((sum) => typeof sum === 'string' && /^[a-f0-9]{128}$/u.test(sum))
  );
}

/** Strict parse; the same shape `verity-host-runtime` validates before it touches the host. */
export function parseHostRuntimeRequirements(value: unknown): HostRuntimeRequirements | null {
  if (
    !isRecord(value) ||
    !(
      exactKeys(value, ['release', 'sha512', 'runtimes']) ||
      exactKeys(value, ['release', 'sha512', 'archiveSha512', 'runtimes'])
    )
  )
    return null;
  const { release, sha512, archiveSha512, runtimes } = value;
  if (typeof release !== 'string' || !/^release-[0-9]{8}\.[0-9]+$/u.test(release)) return null;
  if (!isArchitectureSums(sha512)) return null;
  if ('archiveSha512' in value && !isArchitectureSums(archiveSha512)) return null;
  if (!isRecord(runtimes) || !exactKeys(runtimes, HOST_RUNTIME_NAMES)) return null;
  const allowed: readonly string[] = HOST_RUNTIME_ALLOWED_ARGS;
  for (const args of Object.values(runtimes)) {
    if (!Array.isArray(args) || args.length === 0 || args.length > 8) return null;
    if (!args.every((arg) => typeof arg === 'string' && allowed.includes(arg))) return null;
  }
  return value as unknown as HostRuntimeRequirements;
}

/**
 * The target release's declaration, or `undefined` for a release from before this label
 * existed — which declares nothing, so there is nothing to reconcile. A label that is present
 * but unreadable is refused: silently skipping it would activate exactly the release this
 * exists to hold back.
 */
export async function readTargetHostRuntimes(
  docker: Pick<DockerClient, 'inspectImageLabels'>,
  image: string,
): Promise<HostRuntimeRequirements | undefined> {
  // Like readBundledPostgresImage: only a test double lacks this. The production client has it,
  // which host-runtimes.test.ts pins, so this is never how a real host skips the check.
  if (docker.inspectImageLabels === undefined) return undefined;
  const raw = (await docker.inspectImageLabels(image))?.[HOST_RUNTIMES_LABEL];
  if (raw === undefined || raw === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const requirements = parseHostRuntimeRequirements(parsed);
  if (requirements === null)
    throw new HostRuntimeError(`target image declares malformed ${HOST_RUNTIMES_LABEL}`);
  return requirements;
}

function hostRuntimePath(release: string): string {
  return `/opt/verity/runsc/${release}/runsc`;
}

/** Whether the installed host runtime service advertises that it installs archive pins. */
function installsArchives(agent: unknown): boolean {
  return (
    isRecord(agent) &&
    Array.isArray(agent.runtimeArtifacts) &&
    agent.runtimeArtifacts.includes('archive')
  );
}

/** Names of the declared runtimes dockerd does not currently report exactly as declared. */
async function unsatisfiedHostRuntimes(
  docker: Pick<DockerClient, 'inspectRuntime'>,
  requirements: HostRuntimeRequirements,
): Promise<HostRuntimeName[]> {
  if (docker.inspectRuntime === undefined)
    throw new HostRuntimeError('Docker runtime inspection is unavailable');
  const path = hostRuntimePath(requirements.release);
  const missing: HostRuntimeName[] = [];
  for (const name of HOST_RUNTIME_NAMES) {
    const registered = await docker.inspectRuntime(name);
    const want = requirements.runtimes[name];
    if (
      registered === undefined ||
      registered.path !== path ||
      registered.args.length !== want.length ||
      registered.args.some((arg, index) => arg !== want[index])
    ) {
      missing.push(name);
    }
  }
  return missing;
}

export interface HostRuntimeResult {
  readonly id: string;
  readonly ok: boolean;
  readonly message: string;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * The answer and the time it was written, from ONE open file. The host replaces result.json by
 * rename, so a read followed by a separate stat could pair an earlier failure's content with the
 * new answer's mtime and take that failure for a fresh one.
 */
async function readResult(
  path: string,
): Promise<{ result: HostRuntimeResult | undefined; mtimeMs: number }> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { result: undefined, mtimeMs: 0 };
    throw error;
  }
  try {
    const { mtimeMs } = await handle.stat();
    let parsed: unknown;
    try {
      parsed = JSON.parse(await handle.readFile('utf8'));
    } catch {
      parsed = undefined;
    }
    return { result: parseResult(parsed), mtimeMs };
  } finally {
    await handle.close();
  }
}

function parseResult(value: unknown): HostRuntimeResult | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (typeof value.id !== 'string' || typeof value.ok !== 'boolean') return undefined;
  return {
    id: value.id,
    ok: value.ok,
    message: typeof value.message === 'string' ? value.message.slice(0, 500) : '',
  };
}

export interface HostAnswerRequest {
  /** The host directory both files live in, as this container sees it. */
  readonly dir: string;
  readonly request: string;
  readonly result: string;
  /** Stable across a resumed operation, so a crash reuses the request and its answer. */
  readonly id: string;
  readonly body: object;
  readonly timeoutMs: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/**
 * Ask a root host component, through its request file, and wait for its answer to THIS request.
 * `undefined` means nothing answered in time. A successful answer already on file for the same id
 * is reused, so a resumed operation does not ask twice.
 */
export async function requestHostAnswer(
  options: HostAnswerRequest,
): Promise<HostRuntimeResult | undefined> {
  const resultPath = join(options.dir, options.result);
  const previous = (await readResult(resultPath)).result;
  if (previous?.id === options.id && previous.ok) return previous;
  const requestPath = join(options.dir, options.request);
  const temporary = join(options.dir, `.${options.request}.${String(process.pid)}`);
  await mkdir(options.dir, { recursive: true });
  await writeFile(temporary, `${JSON.stringify(options.body)}\n`, { mode: 0o600 });
  // A rename is what the path unit sees, and it lands the whole request at once.
  await rename(temporary, requestPath);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const deadline = now() + options.timeoutMs;
  const startedAt = (await stat(requestPath)).mtimeMs;
  for (;;) {
    const { result: candidate, mtimeMs } = await readResult(resultPath);
    // An older failure for this same id is not an answer to the request just written.
    if (candidate?.id === options.id && (candidate.ok || mtimeMs >= startedAt)) return candidate;
    if (now() >= deadline) return undefined;
    await sleep(options.pollMs ?? 1_000);
  }
}

export interface ReconcileHostRuntimesOptions {
  readonly docker: Pick<DockerClient, 'inspectRuntime'>;
  readonly requirements: HostRuntimeRequirements;
  /**
   * Bring the host components up to the target release through a path that already runs
   * release-bundled code on the host (the devcontainer builder service), for a host whose
   * runtime service predates archive pins. Resolves to why that did not happen, or `undefined`
   * once it did. Without it such a host can only be moved forward by the installer.
   */
  readonly serviceRequirements?: RuntimeServiceRequirements;
  readonly renewHostRuntimeService?: () => Promise<void>;
  readonly onProgress?: (stage: 'renewing' | 'registering' | 'recovery-required') => Promise<void>;
  readonly refreshHostComponents?: () => Promise<string | undefined>;
  /** Stable across a resumed operation, so a crash reuses the request and its answer. */
  readonly requestId: string;
  readonly requestDir?: string;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/**
 * Make the host satisfy `requirements`, or throw a {@link HostRuntimeError} that says what the
 * operator has to do. Idempotent: an already-satisfied host costs two `GET /info` reads and no
 * request; a resumed operation finds its own earlier answer by request id.
 */
export async function reconcileHostRuntimes(options: ReconcileHostRuntimesOptions): Promise<void> {
  const { docker, requirements, requestId } = options;
  const missing = await unsatisfiedHostRuntimes(docker, requirements);
  const dir = options.requestDir ?? HOST_RUNTIME_REQUEST_DIR;
  const pending = async (name: string): Promise<boolean> =>
    stat(join(dir, `${name}-install.pending`)).then(
      () => true,
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      },
    );
  let servicePending = await pending('service');
  const daemonPending = await pending('daemon');
  if (
    missing.length === 0 &&
    options.serviceRequirements === undefined &&
    !servicePending &&
    !daemonPending
  )
    return;
  const need = `Docker runtime ${(missing.length === 0 ? HOST_RUNTIME_NAMES : missing).join(' and ')} (${requirements.release})`;

  let agent = await readJson(join(dir, 'agent.json')).catch(() => undefined);
  const supports = (candidate: unknown): boolean => {
    if (servicePending || !isRecord(candidate) || candidate.version !== 1) return false;
    if (
      candidate.trigger !== 'systemd-path' &&
      !(candidate.trigger === 'none' && missing.length === 0)
    )
      return false;
    if (requirements.archiveSha512 !== undefined && !installsArchives(candidate)) return false;
    const wanted = options.serviceRequirements;
    if (wanted === undefined) return true;
    const service = candidate.runtimeService;
    return (
      isRecord(service) &&
      typeof service.revision === 'number' &&
      service.revision >= wanted.revision &&
      service.renewalProtocol === wanted.renewalProtocol &&
      Array.isArray(service.features) &&
      wanted.features.every((feature) => (service.features as unknown[]).includes(feature))
    );
  };
  if (!supports(agent) && options.renewHostRuntimeService !== undefined) {
    await options.onProgress?.('renewing');
    try {
      await options.renewHostRuntimeService();
    } catch (error) {
      throw new HostRuntimeError(
        `This release needs ${need}. ${error instanceof Error ? error.message : 'Host runtime service renewal failed.'} The current version keeps serving.`,
      );
    }
    agent = await readJson(join(dir, 'agent.json')).catch(() => undefined);
    servicePending = await pending('service');
    if (!supports(agent))
      throw new HostRuntimeError(
        `This release needs ${need}, but the renewed host runtime service does not advertise the required capabilities. The current version keeps serving. ${REPAIR}`,
      );
  }
  if (!isRecord(agent) || agent.version !== 1) {
    throw new HostRuntimeError(
      `This release needs ${need}, and this host has no Verity host runtime service to register it. ${REPAIR}`,
    );
  }
  if (options.serviceRequirements !== undefined && !supports(agent))
    throw new HostRuntimeError(
      `This release needs newer host runtime service capabilities. The current version keeps serving. ${REPAIR}`,
    );
  if (servicePending)
    throw new HostRuntimeError(`Host runtime service installation needs recovery. ${REPAIR}`);
  if (!daemonPending && (await unsatisfiedHostRuntimes(docker, requirements)).length === 0) return;
  if (agent.trigger !== 'systemd-path') {
    throw new HostRuntimeError(
      `This release needs ${need}. This host has no systemd, so the host runtime service cannot ` +
        'run on request; re-run the Verity installer on the host, then retry the update.',
    );
  }
  await options.onProgress?.('registering');
  if (requirements.archiveSha512 !== undefined && !installsArchives(agent)) {
    // The builder service installs the bundle out of the verified target image, and that
    // bundle both registers the target's runtimes and replaces the host runtime service. So
    // afterwards either nothing is missing any more, or the service takes the request below.
    await options.refreshHostComponents?.();
    if ((await unsatisfiedHostRuntimes(docker, requirements)).length === 0) return;
    const refreshed = await readJson(join(dir, 'agent.json')).catch(() => undefined);
    if (!installsArchives(refreshed)) {
      throw new HostRuntimeError(
        `This release needs ${need}, which gVisor ships as a release archive, and this host's ` +
          'runtime service predates archives. ' +
          'The current version keeps serving. ' +
          REPAIR,
      );
    }
  }

  const answerId = daemonPending ? `${requestId}:recovery:${randomUUID()}` : requestId;
  const result = await requestHostAnswer({
    dir,
    request: 'request.json',
    result: 'result.json',
    // A prior successful answer must not bypass an unfinished host transaction.
    id: answerId,
    body: { version: 1, id: answerId, requirements },
    timeoutMs: options.timeoutMs ?? 15 * 60_000,
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (result === undefined) {
    throw new HostRuntimeError(
      `This release needs ${need}, and the host runtime service did not answer. Check ` +
        '`journalctl -u verity-host-runtime` on the host, then retry the update.',
    );
  }
  if (!result.ok) {
    if (result.message.startsWith('recovery-required:'))
      await options.onProgress?.('recovery-required');
    throw new HostRuntimeError(
      `This release needs ${need}, and the host could not register it: ${result.message}. ` +
        'The current version keeps serving; fix the cause on the host, then retry the update.',
    );
  }
  if (await pending('daemon'))
    throw new HostRuntimeError(`Host runtime registration needs recovery. ${REPAIR}`);
  const still = await unsatisfiedHostRuntimes(docker, requirements);
  if (still.length > 0) {
    throw new HostRuntimeError(
      `The host runtime service reported success, but Docker still does not report ` +
        `${still.join(' and ')} as ${requirements.release} declares. ${REPAIR}`,
    );
  }
}
