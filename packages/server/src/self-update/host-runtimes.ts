import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DockerClient } from '../docker.js';

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

export interface HostRuntimeRequirements {
  readonly release: string;
  readonly sha512: { readonly x86_64: string; readonly aarch64: string };
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

/** Strict parse; the same shape `verity-host-runtime` validates before it touches the host. */
export function parseHostRuntimeRequirements(value: unknown): HostRuntimeRequirements | null {
  if (!isRecord(value) || !exactKeys(value, ['release', 'sha512', 'runtimes'])) return null;
  const { release, sha512, runtimes } = value;
  if (typeof release !== 'string' || !/^release-[0-9]{8}\.[0-9]+$/u.test(release)) return null;
  if (!isRecord(sha512) || !exactKeys(sha512, ['x86_64', 'aarch64'])) return null;
  if (
    !Object.values(sha512).every((sum) => typeof sum === 'string' && /^[a-f0-9]{128}$/u.test(sum))
  )
    return null;
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

interface HostRuntimeResult {
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

export interface ReconcileHostRuntimesOptions {
  readonly docker: Pick<DockerClient, 'inspectRuntime'>;
  readonly requirements: HostRuntimeRequirements;
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
  if (missing.length === 0) return;
  const need = `Docker runtime ${missing.join(' and ')} (${requirements.release})`;

  const dir = options.requestDir ?? HOST_RUNTIME_REQUEST_DIR;
  const agent = await readJson(join(dir, 'agent.json')).catch(() => undefined);
  if (!isRecord(agent) || agent.version !== 1) {
    throw new HostRuntimeError(
      `This release needs ${need}, and this host has no Verity host runtime service to register it. ${REPAIR}`,
    );
  }
  if (agent.trigger !== 'systemd-path') {
    throw new HostRuntimeError(
      `This release needs ${need}. This host has no systemd, so the host runtime service cannot ` +
        'run on request; re-run the Verity installer on the host, then retry the update.',
    );
  }

  const resultPath = join(dir, 'result.json');
  let result = (await readResult(resultPath)).result;
  if (result?.id !== requestId || !result.ok) {
    const requestPath = join(dir, 'request.json');
    const temporary = join(dir, `.request.json.${String(process.pid)}`);
    await mkdir(dir, { recursive: true });
    await writeFile(temporary, `${JSON.stringify({ version: 1, id: requestId, requirements })}\n`, {
      mode: 0o600,
    });
    // A rename is what the path unit sees, and it lands the whole request at once.
    await rename(temporary, requestPath);
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
    const deadline = now() + (options.timeoutMs ?? 15 * 60_000);
    const startedAt = (await stat(requestPath)).mtimeMs;
    for (;;) {
      const { result: candidate, mtimeMs } = await readResult(resultPath);
      // An older failure for this same id is not an answer to the request just written.
      if (candidate?.id === requestId && (candidate.ok || mtimeMs >= startedAt)) {
        result = candidate;
        break;
      }
      if (now() >= deadline) {
        throw new HostRuntimeError(
          `This release needs ${need}, and the host runtime service did not answer. Check ` +
            '`journalctl -u verity-host-runtime` on the host, then retry the update.',
        );
      }
      await sleep(options.pollMs ?? 1_000);
    }
  }
  if (!result.ok) {
    throw new HostRuntimeError(
      `This release needs ${need}, and the host could not register it: ${result.message}. ` +
        'The current version keeps serving; fix the cause on the host, then retry the update.',
    );
  }
  const still = await unsatisfiedHostRuntimes(docker, requirements);
  if (still.length > 0) {
    throw new HostRuntimeError(
      `The host runtime service reported success, but Docker still does not report ` +
        `${still.join(' and ')} as ${requirements.release} declares. ${REPAIR}`,
    );
  }
}
