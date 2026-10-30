import { execFile, spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  unlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const GiB = 1024 ** 3;
/** Marks a rejection whose command exited on its own with a status. */
const EXITED = Symbol('exited');
const execFileAsync = promisify(execFile);
const reportSchema = z.object({
  schemaVersion: z.literal(1),
  observedAt: z.iso.datetime(),
  hostBootId: z.uuid().optional(),
  hostIdentity: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  roots: z.array(
    z.object({
      kind: z.enum(['buildkit', 'docker', 'containerd', 'export', 'project']),
      observedAt: z.iso.datetime().optional(),
      state: z.enum(['available', 'unavailable']),
      availableBytes: z.number().nonnegative().finite().optional(),
      freeInodes: z.number().nonnegative().finite().optional(),
      filesystemId: z.string().min(1).optional(),
    }),
  ),
});
const identitySchema = z.object({
  hostBootId: z.uuid(),
  hostIdentity: z.string().regex(/^[a-f0-9]{64}$/),
});
const ownerSchema = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  namespace: z.string(),
  start: z.string(),
  /** Boot the attempt started in; a later boot proves every local process of it ended. */
  hostBootId: z.uuid().optional(),
  /** The host admission marker this attempt holds, released with it. */
  admissionMarker: z.string().optional(),
});
const remoteRecordSchema = z.object({
  version: z.literal(1),
  operation: z.enum(['build-export', 'image-import']),
  hostBootId: z.uuid(),
  hostIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  startedAt: z.iso.datetime(),
  /** What the attempt was admitted for; an unresolved record reserves this much. */
  estimateBytes: z.number().int().nonnegative().optional(),
});
type RemoteOperation = z.infer<typeof remoteRecordSchema>['operation'];

/**
 * An attempt from another PID namespace (the previous Server container) has no
 * process this one can inspect. Every command the Server runs is bounded by its own
 * timeout (at most 30 minutes) while that Server lives, and its container takes
 * the commands with it when it stops, so an attempt older than this has no live
 * local writer left.
 */
const FOREIGN_ATTEMPT_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** Age after which a remote operation's client in another PID namespace is trusted
 *  gone: `docker load` is bounded by a 15-minute client timeout and a build command
 *  by at most 30 minutes, and a replaced Server container takes its commands along. */
const CLIENT_MAX_AGE_MS = 60 * 60 * 1000;

// A failing transport is not an answer from the remote side: the work may still run.
const TRANSPORT_FAILURE =
  /rpc error|\b(?:Unavailable|Canceled|DeadlineExceeded|Unknown|Internal|Aborted):|deadline exceeded|connection (?:reset|refused|lost|closed|closing)|broken pipe|transport is closing|error reading from server|context canceled|i\/o timeout|EOF\s*$/i;

/**
 * Whether a failed remote command's own output proves that the remote side answered
 * with a final result, so nothing of it can still be running.
 *
 * Deliberately narrow, and read from the client's own last report rather than from
 * any line: build steps print arbitrary text, including text that looks like a
 * BuildKit error. For an export, the client's last `ERROR:` line must be the solve
 * report (`failed to solve:`, optionally wrapped in `failed to build:`) and name a
 * build step's process exit — the solve's own verdict. For an import, the last line
 * must be the Engine's `Error response from daemon:` and not a transport failure.
 * Everything else — a killed client, a timeout, a lost connection, any other error —
 * leaves the remote state unknown, and reconciliation decides later.
 */
export function remoteOperationEnded(operation: RemoteOperation, output: string): boolean {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (operation === 'build-export') {
    // Newer buildx wraps the solve error as `ERROR: failed to build: failed to solve:`.
    // The client's last `ERROR:` line is its final report; a later transport error
    // must win over an earlier step verdict.
    const verdict = lines
      .filter((line) => line.startsWith('ERROR: '))
      .at(-1)
      ?.replace(/^ERROR: failed to build: (?=failed to solve:)/, 'ERROR: ');
    return (
      verdict !== undefined &&
      /^ERROR: failed to solve: process ".*" did not complete successfully: exit code: \d+$/.test(
        verdict,
      ) &&
      !TRANSPORT_FAILURE.test(verdict)
    );
  }
  const answer = lines.filter((line) => !line.startsWith('Build command exited')).at(-1);
  return (
    answer !== undefined &&
    answer.startsWith('Error response from daemon:') &&
    !TRANSPORT_FAILURE.test(answer)
  );
}

/** An attempt whose remote work could not be shown to have ended. It reserves only its
 *  own estimate; it never blocks other builds. */
export interface UnresolvedBuildAttempt {
  attempt: string;
  operation: RemoteOperation | 'local';
  startedAt?: string;
  reservedBytes: number;
  reason: string;
}

/** The answer of the BuildKit worker to "is any build still running?". `undefined`
 *  when it could not be asked. */
export type BuildkitIdleProbe = () => Promise<boolean | undefined>;

function processStart(pid: number): string {
  // comm may contain spaces and parentheses; fields after its final ')' are stable.
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/)[19]!;
}
function existsProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
function unavailable(detail: string): never {
  throw new Error(
    `Build storage unavailable: ${detail}. Refresh host storage diagnostics or repair the builder installation; existing project data is preserved.`,
  );
}

export interface BuildStoragePolicy {
  /** Includes all remaining snapshot, archive, import and context growth. */
  estimateBytes: number;
  reserveBytes: number;
  reserveInodes: number;
}

export function buildStoragePolicy(
  environment: NodeJS.ProcessEnv = process.env,
): BuildStoragePolicy {
  const positive = (name: string, fallback: number, maxDigits = 6): number => {
    const value = environment[name];
    if (value === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(value) || value.length > maxDigits) throw new Error(`Invalid ${name}`);
    return Number(value);
  };
  return {
    // Used only when no valid project image measurement is available.
    estimateBytes: positive('VERITY_BUILD_ESTIMATE_GIB', 24) * GiB,
    reserveBytes: positive('VERITY_BUILD_FREE_GIB', 10) * GiB,
    reserveInodes: positive('VERITY_BUILD_FREE_INODES', 1_000_000, 12),
  };
}

/**
 * Overlayfs admission heuristic: 2 GiB context allowance plus twice the previous
 * uncompressed image size. One image covers an export archive without assuming
 * compression; the other allows changed snapshots and import growth (unchanged
 * layers are shared). Bound the heuristic to 12–96 GiB. This is not a peak-space
 * guarantee: arbitrary build steps can outgrow it, so live reserve checks remain.
 */
export function estimateBuildStorageBytes(policy: BuildStoragePolicy, imageBytes?: number): number {
  if (imageBytes === undefined || !Number.isSafeInteger(imageBytes) || imageBytes <= 0)
    return policy.estimateBytes;
  return Math.ceil(Math.min(96 * GiB, Math.max(12 * GiB, 2 * GiB + 2 * imageBytes)));
}

export interface BuildStorageLease {
  directory: string;
  /** Remote work may still use the context or archive; preserve both and admission. */
  readonly retainArtifacts: boolean;
  reserveBuild(imageBytes?: number): void;
  run(
    this: void,
    command: string,
    args: string[],
    options: {
      remoteOperation?: 'build-export' | 'image-import';
      env: NodeJS.ProcessEnv;
      signal?: AbortSignal;
      timeout: number;
      maxBuffer: number;
    },
  ): Promise<{ stdout: string; stderr: string }>;
  dispose(): void;
}

/**
 * What the host has provisioned for build admission. The host builder
 * installation creates the lock and the lease directory together before any
 * snapshotter maintenance can run, so a directory with neither marks a host
 * whose builder predates managed admission, not one in maintenance.
 */
export type BuilderAdmissionState =
  | { state: 'provisioned' }
  | { state: 'migration-pending' }
  | { state: 'not-provisioned' }
  | { state: 'incomplete'; missing: string[] };

const NOT_PROVISIONED_MESSAGE =
  "This host's devcontainer builder predates managed build admission, so builds run without host storage admission. Re-run the verified Verity installer once on the host to provision it.";

export function builderAdmissionMessage(admission: BuilderAdmissionState): string {
  switch (admission.state) {
    case 'provisioned':
      return 'Managed build admission is provisioned.';
    case 'migration-pending':
      return 'Builder migration recovery is pending; new builds wait until the host verifies the previous worker.';
    case 'not-provisioned':
      return NOT_PROVISIONED_MESSAGE;
    case 'incomplete':
      return `Managed build admission is incomplete (missing ${admission.missing.join(', ')}); re-run the verified Verity installer once on the host.`;
  }
}

export function readBuilderAdmissionState(directory: string): BuilderAdmissionState {
  const present = (name: string) => {
    try {
      lstatSync(join(directory, name));
      return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
      // Unreadable is not absent: never relax admission on an error we cannot classify.
      throw cause;
    }
  };
  if (present('migration-pending')) return { state: 'migration-pending' };
  const markers = ['build-admission.lock', 'leases'];
  const missing = markers.filter((name) => !present(name));
  if (missing.length === 0) return { state: 'provisioned' };
  if (missing.length === markers.length) return { state: 'not-provisioned' };
  return { state: 'incomplete', missing };
}

export interface HostStorageEvidence {
  /** Lowest measured free bytes across the host roots, when any was measured. */
  availableBytes?: number;
  freeInodes?: number;
  /** Why a root was not measured; empty when every root was. */
  problems: string[];
}

const HOST_STORAGE_ROOTS = ['buildkit', 'docker', 'containerd', 'export', 'project'] as const;

/**
 * Reads the host storage report as measurements. A missing, stale or partial
 * report is not evidence of low space: admission then checks what was measured
 * and names the gaps, instead of refusing every build because a reporter or its
 * configuration is missing while the disks have room.
 */
export function readHostStorageEvidence(
  reportFile: string,
  now: number = Date.now(),
): HostStorageEvidence {
  let report: z.infer<typeof reportSchema>;
  try {
    const input = readFileSync(reportFile, 'utf8');
    if (input.length > 262144) return { problems: ['host storage report exceeds its size limit'] };
    report = reportSchema.parse(JSON.parse(input));
  } catch {
    return { problems: ['host storage report is missing or invalid'] };
  }
  const fresh = (observedAt: string | undefined) => {
    if (observedAt === undefined) return false;
    const age = now - Date.parse(observedAt);
    return age >= -5000 && age <= 120_000;
  };
  if (!fresh(report.observedAt)) return { problems: ['host storage report is stale'] };
  const evidence: HostStorageEvidence = { problems: [] };
  for (const kind of HOST_STORAGE_ROOTS) {
    const roots = report.roots.filter((root) => root.kind === kind);
    const root = roots[0];
    if (
      roots.length !== 1 ||
      root?.state !== 'available' ||
      root.availableBytes === undefined ||
      root.freeInodes === undefined ||
      root.filesystemId === undefined
    ) {
      evidence.problems.push(`${kind} filesystem is not established`);
      continue;
    }
    if (!fresh(root.observedAt)) {
      evidence.problems.push(`${kind} filesystem sample is stale or missing`);
      continue;
    }
    // Treat all roots as aliases for admission. Summing independent free
    // budgets would over-admit on the common single-host-filesystem layout.
    evidence.availableBytes = Math.min(evidence.availableBytes ?? Infinity, root.availableBytes);
    evidence.freeInodes = Math.min(evidence.freeInodes ?? Infinity, root.freeInodes);
  }
  return evidence;
}

/** Attempt directories a lease in this process holds right now, across instances. */
const activeDirectories = new Set<string>();

/** One active Server owns an Engine, as with derived-image collection. All
 * projects share this admission gate, including context staging and import.
 * Recovery only removes positively identified abandoned attempts. An attempt that
 * cannot be shown to have ended keeps its files and its estimated space, but no
 * longer blocks other builds; {@link BuildStorage.reconcile} releases it once the
 * worker, the boot or the elapsed time proves it ended.
 */
export class BuildStorageCapacityError extends Error {}

export class BuildStorage {
  private reclaimer?: () => Promise<void>;
  setReclaimer(reclaim: () => Promise<void>): void {
    this.reclaimer = reclaim;
  }

  private held = false;
  /** Builds waiting for this Server's one lease, first come first served. */
  private readonly waiting: Array<() => void> = [];
  /** A waiter was woken and has not yet taken its turn; newcomers queue behind it. */
  private handingOver = false;
  private currentDirectory: string | undefined;
  private unresolved: UnresolvedBuildAttempt[] = [];
  private warnedUnprovisioned = false;
  private evidenceWarning = '';
  private warnedRemoteRecord = false;
  constructor(
    readonly root: string,
    private readonly reportFile = '/run/verity-host-diagnostics/storage.json',
    private readonly policy = buildStoragePolicy(),
    private readonly localDisk = () => {
      const stats = statfsSync(this.root);
      return { availableBytes: stats.bavail * stats.bsize, freeInodes: stats.ffree };
    },
    private readonly admissionDirectory?: string,
  ) {}

  private check(bytes: number, host: boolean): void {
    const unresolvedBytes = this.unresolved.reduce((sum, entry) => sum + entry.reservedBytes, 0);
    bytes += unresolvedBytes;
    const local = this.localDisk();
    let available = local.availableBytes;
    let inodes = local.freeInodes;
    if (host) {
      const evidence = readHostStorageEvidence(this.reportFile);
      if (evidence.availableBytes !== undefined)
        available = Math.min(available, evidence.availableBytes);
      if (evidence.freeInodes !== undefined) inodes = Math.min(inodes, evidence.freeInodes);
      this.reportEvidence(evidence.problems);
    }
    if (available < bytes + this.policy.reserveBytes || inodes < this.policy.reserveInodes) {
      throw new BuildStorageCapacityError(
        `Build storage admission rejected: available ${Math.floor(available / GiB)} GiB and ${inodes} free inodes; requires ${Math.ceil(bytes / GiB)} GiB estimated growth plus ${Math.ceil(this.policy.reserveBytes / GiB)} GiB reserve and ${this.policy.reserveInodes} free inodes.` +
          (unresolvedBytes > 0
            ? ` ${Math.ceil(unresolvedBytes / GiB)} GiB of that is held by ${this.unresolved.length} earlier build attempt(s) whose end is not yet confirmed (${this.unresolved.map((entry) => entry.attempt).join(', ')}); they are released automatically once the builder confirms they ended.`
            : '') +
          ' Retry after capacity is available or configure an estimate supported by bounded build measurements.',
      );
    }
  }

  // Logged when the set of evidence gaps changes, not on every two-second sample.
  private reportEvidence(problems: string[]): void {
    const warning = problems.join('; ');
    if (warning === this.evidenceWarning) return;
    this.evidenceWarning = warning;
    if (warning !== '')
      console.warn(
        `Build storage admission is using partial host evidence (${warning}); only measured filesystems are checked.`,
      );
  }

  /**
   * The Provisioner's entry point. On a host without managed admission the
   * build takes the unmanaged path it took before admission existed: host
   * storage reports and the lock come from the same host installation, so
   * neither can be required where the other was never provisioned. Every other
   * state that is not a held shared lock fails closed.
   */
  admit(): BuildStorageLease {
    if (this.admissionDirectory !== undefined) {
      const admission = this.admissionState(this.admissionDirectory);
      if (admission.state === 'not-provisioned') {
        if (!this.warnedUnprovisioned) {
          this.warnedUnprovisioned = true;
          console.warn(builderAdmissionMessage(admission));
        }
        return this.unmanagedLease(this.admissionDirectory);
      }
    }
    return this.acquire();
  }

  /**
   * {@link admit}, but a build that finds another project's build holding this
   * Server's lease waits for its turn instead of failing with "busy". Waiters are
   * served in arrival order. Every other refusal — capacity, host maintenance,
   * an unreadable admission state — still fails at once, as {@link admit} does.
   * A build holds the lease for at most its commands' bounds, so the wait is
   * bounded too.
   */
  async admitInTurn(onQueued?: (ahead: number) => void): Promise<BuildStorageLease> {
    if (this.held || this.handingOver || this.waiting.length > 0) {
      // A refusal that does not depend on the lease answers now, not after the wait;
      // admit() checks everything again once the turn comes.
      this.refuseUnadmittableHost();
      const ahead = this.waiting.length + 1;
      const turn = new Promise<void>((resolve) => this.waiting.push(resolve));
      // Only a notice: a failing one must not leave a woken turn unclaimed.
      try {
        onQueued?.(ahead);
      } catch {
        /* the wait goes on */
      }
      await turn;
      this.handingOver = false;
    }
    try {
      try {
        return this.admit();
      } catch (error) {
        if (!(error instanceof BuildStorageCapacityError) || !this.reclaimer) throw error;
        // One bounded pass; a timeout fails closed while the coalesced collector finishes.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.reclaimer(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new Error('Storage reclamation timed out; retry after cleanup finishes')),
                120_000,
              );
              timer.unref();
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        return this.admit();
      }
    } finally {
      // An unmanaged lease or a refusal leaves the lease free for the next waiter.
      if (!this.held) this.wakeNext();
    }
  }

  /** The host-side refusals of {@link acquire}, without taking a lease or marker. */
  private refuseUnadmittableHost(): void {
    if (this.admissionDirectory === undefined) return;
    const admission = this.admissionState(this.admissionDirectory);
    if (admission.state === 'not-provisioned') return;
    if (admission.state !== 'provisioned')
      throw new Error(`Builder admission unavailable: ${builderAdmissionMessage(admission)}`);
    let reason: string | undefined;
    const fd = openSync(join(this.admissionDirectory, 'build-admission.lock'), 'r');
    try {
      const locked = spawnSync('flock', ['--shared', '--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'pipe', fd],
        timeout: 5000,
      });
      if (locked.status !== 0) reason = 'builder maintenance is in progress';
      else if (existsSync(join(this.admissionDirectory, 'migration-pending')))
        reason = 'builder migration recovery is pending';
    } finally {
      closeSync(fd);
    }
    if (reason !== undefined)
      throw new Error(
        `Builder admission unavailable: ${reason}; retry after managed maintenance completes`,
      );
  }

  private wakeNext(): void {
    const next = this.waiting.shift();
    if (next === undefined) return;
    this.handingOver = true;
    next();
  }

  /**
   * A Repair can provision the host while this attempt is still staging. Remote
   * work therefore looks again before it starts and, once the lock exists,
   * holds it shared like any managed build, so host maintenance waits for it
   * instead of restarting the worker underneath it.
   */
  private unmanagedLease(admissionDirectory: string): BuildStorageLease {
    let admissionFd: number | undefined;
    let admissionMarker: string | undefined;
    const enterProvisionedHost = () => {
      const admission = this.admissionState(admissionDirectory);
      if (admission.state === 'not-provisioned') return;
      if (admission.state !== 'provisioned')
        throw new Error(`Builder admission unavailable: ${builderAdmissionMessage(admission)}`);
      const fd = openSync(join(admissionDirectory, 'build-admission.lock'), 'r');
      try {
        const locked = spawnSync('flock', ['--shared', '--nonblock', '3'], {
          stdio: ['ignore', 'ignore', 'pipe', fd],
          timeout: 5000,
        });
        if (locked.status !== 0)
          throw new Error(
            'Builder admission unavailable: the host was provisioned during this build and its maintenance is in progress; retry the build',
          );
        if (existsSync(join(admissionDirectory, 'migration-pending')))
          throw new Error(
            'Builder admission unavailable: builder migration recovery is pending; retry the build',
          );
        admissionMarker = mkdtempSync(join(admissionDirectory, 'leases', 'attempt-'));
      } catch (cause) {
        closeSync(fd);
        throw cause;
      }
      admissionFd = fd;
    };
    return {
      directory: tmpdir(),
      retainArtifacts: false,
      reserveBuild: () => {},
      run: async (command, args, options) => {
        if (options.remoteOperation !== undefined && admissionFd === undefined)
          enterProvisionedHost();
        return execFileAsync(command, args, {
          env: options.env,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          timeout: options.timeout,
          maxBuffer: options.maxBuffer,
          encoding: 'utf8',
        });
      },
      dispose: () => {
        if (admissionMarker !== undefined) rmSync(admissionMarker, { recursive: true });
        if (admissionFd !== undefined) closeSync(admissionFd);
        admissionMarker = undefined;
        admissionFd = undefined;
      },
    };
  }

  private admissionState(directory: string): BuilderAdmissionState {
    try {
      return readBuilderAdmissionState(directory);
    } catch (cause) {
      throw new Error('Builder admission state could not be read; builds remain paused', {
        cause,
      });
    }
  }

  acquire(): BuildStorageLease {
    let admissionFd: number | undefined;
    let admissionMarker: string | undefined;
    if (this.admissionDirectory !== undefined) {
      const admission = this.admissionState(this.admissionDirectory);
      if (admission.state !== 'provisioned')
        throw new Error(`Builder admission unavailable: ${builderAdmissionMessage(admission)}`);
      try {
        admissionFd = openSync(join(this.admissionDirectory, 'build-admission.lock'), 'r');
        const locked = spawnSync('flock', ['--shared', '--nonblock', '3'], {
          stdio: ['ignore', 'ignore', 'pipe', admissionFd],
          timeout: 5000,
        });
        if (locked.status !== 0) throw new Error('builder maintenance is in progress');
        if (existsSync(join(this.admissionDirectory, 'migration-pending')))
          throw new Error('builder migration recovery is pending');
        // The shared descriptor fences the check/create race with the host's exclusive lock.
        // The marker survives a Server crash or ambiguous remote cancellation.
        admissionMarker = mkdtempSync(join(this.admissionDirectory, 'leases', 'attempt-'));
      } catch (cause) {
        if (admissionFd !== undefined) closeSync(admissionFd);
        throw new Error(
          `Builder admission unavailable: ${cause instanceof Error ? cause.message : String(cause)}; retry after managed maintenance completes`,
          { cause },
        );
      }
    }
    try {
      return this.acquireLease(
        admissionMarker,
        () => {
          if (admissionMarker !== undefined) rmSync(admissionMarker, { recursive: true });
          if (admissionFd !== undefined) closeSync(admissionFd);
        },
        () => {
          if (admissionFd !== undefined) closeSync(admissionFd);
        },
      );
    } catch (cause) {
      if (admissionMarker !== undefined) rmSync(admissionMarker, { recursive: true });
      if (admissionFd !== undefined) closeSync(admissionFd);
      throw cause;
    }
  }

  /** The current host boot and identity from the storage report, when it names them. */
  private hostIdentity(): z.infer<typeof identitySchema> | undefined {
    try {
      return identitySchema.parse(JSON.parse(readFileSync(this.reportFile, 'utf8')));
    } catch {
      return undefined;
    }
  }

  /**
   * Classify the attempt directories left by earlier leases. Provably abandoned ones
   * are removed; ones that cannot be shown to have ended are kept with their files and
   * their estimate, and returned. Only a live owner in this namespace — a build that
   * is still running here — refuses admission.
   */
  private survey(namespace: string): UnresolvedBuildAttempt[] {
    const unresolved: UnresolvedBuildAttempt[] = [];
    if (!existsSync(this.root)) return unresolved;
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.name.startsWith('attempt-')) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) unavailable('unrecognized attempt entry');
      const directory = join(this.root, entry.name);
      if (directory === this.currentDirectory) continue;
      if (activeDirectories.has(directory))
        unavailable('a previous build process still owns its reservation');
      const record = this.readRemoteRecord(directory);
      if (record !== undefined) {
        unresolved.push({
          attempt: entry.name,
          operation: record === 'invalid' ? 'build-export' : record.operation,
          ...(record === 'invalid' ? {} : { startedAt: record.startedAt }),
          reservedBytes:
            record === 'invalid'
              ? this.policy.estimateBytes
              : (record.estimateBytes ?? this.policy.estimateBytes),
          reason: 'remote build/import termination is not yet confirmed',
        });
        continue;
      }
      let owner: z.infer<typeof ownerSchema>;
      try {
        owner = ownerSchema.parse(JSON.parse(readFileSync(join(directory, 'owner.json'), 'utf8')));
      } catch {
        unresolved.push({
          attempt: entry.name,
          operation: 'local',
          reservedBytes: 0,
          reason: 'attempt owner record is unreadable',
        });
        continue;
      }
      if (owner.namespace !== namespace) {
        unresolved.push({
          attempt: entry.name,
          operation: 'local',
          reservedBytes: 0,
          reason: 'attempt belongs to a previous Server process',
        });
        continue;
      }
      if (this.ownerAlive(owner))
        unavailable('a previous build process still owns its reservation');
      if (this.liveChild(directory)) {
        unresolved.push({
          attempt: entry.name,
          operation: 'local',
          reservedBytes: 0,
          reason: 'an abandoned build command may still be running',
        });
        continue;
      }
      this.removeAttempt(directory, owner);
    }
    return unresolved;
  }

  /** Whether the attempt's owner still holds it. This process's own attempts are held
   *  only while a lease has them; once disposed, this process is not their owner. */
  private ownerAlive(owner: z.infer<typeof ownerSchema>): boolean {
    if (!existsProcess(owner.pid) || processStart(owner.pid) !== owner.start) return false;
    return owner.pid !== process.pid;
  }

  private readRemoteRecord(
    directory: string,
  ): z.infer<typeof remoteRecordSchema> | 'invalid' | undefined {
    const path = join(directory, 'remote-operation.json');
    if (!existsSync(path)) return undefined;
    try {
      return remoteRecordSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      return 'invalid';
    }
  }

  private liveChild(directory: string): boolean {
    for (const file of readdirSync(directory)) {
      if (!/^child-\d+$/.test(file)) continue;
      const pid = Number(readFileSync(join(directory, file), 'utf8').trim());
      if (!Number.isSafeInteger(pid) || pid <= 1 || existsProcess(-pid)) return true;
    }
    return false;
  }

  private removeAttempt(directory: string, owner?: z.infer<typeof ownerSchema>): void {
    rmSync(directory, { recursive: true, force: true });
    const marker = owner?.admissionMarker;
    // Only a marker this storage could have created; never a path a record names elsewhere.
    if (
      marker !== undefined &&
      this.admissionDirectory !== undefined &&
      dirname(marker) === join(this.admissionDirectory, 'leases') &&
      /^attempt-[\w-]+$/.test(marker.slice(marker.lastIndexOf('/') + 1))
    )
      rmSync(marker, { recursive: true, force: true });
  }

  private releaseRemoteRecord(directory: string, reason: string): void {
    unlinkSync(join(directory, 'remote-operation.json'));
    const fd = openSync(directory, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    console.warn(
      `Build storage released ${directory.slice(directory.lastIndexOf('/') + 1)}: ${reason}.`,
    );
  }

  /** Earlier attempts that still hold space because their end is not yet confirmed. */
  unresolvedAttempts(): UnresolvedBuildAttempt[] {
    return [...this.unresolved];
  }

  /**
   * Release what earlier attempts provably no longer use. Runs at Server start and
   * periodically, so a record left by an interrupted build heals without a host
   * reboot or an operator.
   *
   * A remote record is released when the host has rebooted since it was written,
   * when the BuildKit worker reports no running build (a solve that is not running
   * cannot resume), or — for an Engine import — when its client has provably exited.
   * An attempt of a previous Server process is removed once the boot changed or it
   * outlived every command bound.
   */
  async reconcile(
    probe: { buildkitIdle?: BuildkitIdleProbe } = {},
    now: number = Date.now(),
  ): Promise<UnresolvedBuildAttempt[]> {
    if (!existsSync(this.root)) {
      this.unresolved = [];
      return [];
    }
    const namespace = readlinkSync('/proc/self/ns/pid');
    const identity = this.hostIdentity();
    let idle: boolean | undefined;
    let asked = false;
    // The worker's answer covers only operations that began before it was asked.
    let askedAt = 0;
    const buildkitIdle = async () => {
      if (!asked) {
        asked = true;
        askedAt = Date.now();
        idle = await probe.buildkitIdle?.().catch(() => undefined);
      }
      return idle;
    };
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.name.startsWith('attempt-') || !entry.isDirectory() || entry.isSymbolicLink())
        continue;
      const directory = join(this.root, entry.name);
      if (directory === this.currentDirectory || activeDirectories.has(directory)) continue;
      let owner: z.infer<typeof ownerSchema> | undefined;
      try {
        owner = ownerSchema.parse(JSON.parse(readFileSync(join(directory, 'owner.json'), 'utf8')));
      } catch {
        owner = undefined;
      }
      const sameNamespace = owner?.namespace === namespace;
      const record = this.readRemoteRecord(directory);
      if (record === 'invalid') continue;
      if (record !== undefined) {
        const rebooted =
          identity !== undefined &&
          (identity.hostBootId !== record.hostBootId ||
            identity.hostIdentity !== record.hostIdentity);
        const age = now - Date.parse(record.startedAt);
        // The record is written before the client submits its work, so a client that
        // is still alive can submit after the worker answered idle. Its own process is
        // only visible from this PID namespace; a foreign client is trusted gone once
        // it outlived every command bound.
        const clientGone = (): boolean =>
          sameNamespace ? !this.liveChild(directory) : age > CLIENT_MAX_AGE_MS;
        let reason: string | undefined;
        if (rebooted) reason = 'the host has restarted since the remote operation began';
        else if (
          record.operation === 'build-export' &&
          clientGone() &&
          (await buildkitIdle()) === true &&
          Date.parse(record.startedAt) < askedAt
        )
          reason = 'the build client has exited and the builder reports no running build';
        else if (record.operation === 'image-import' && clientGone())
          reason = 'the image import client has exited';
        if (reason === undefined) continue;
        // A lease may have been taken, a client started, or this record rewritten,
        // while the worker was asked.
        if (directory === this.currentDirectory || activeDirectories.has(directory)) continue;
        if (!rebooted && !clientGone()) continue;
        const current = this.readRemoteRecord(directory);
        if (
          current === undefined ||
          current === 'invalid' ||
          current.startedAt !== record.startedAt
        )
          continue;
        this.releaseRemoteRecord(directory, reason);
      }
      if (owner === undefined) continue;
      if (sameNamespace) {
        if (this.ownerAlive(owner)) continue;
        if (this.liveChild(directory)) continue;
        this.removeAttempt(directory, owner);
        continue;
      }
      let modified: number;
      try {
        modified = lstatSync(join(directory, 'owner.json')).mtimeMs;
      } catch {
        continue;
      }
      const otherBoot =
        identity !== undefined &&
        owner.hostBootId !== undefined &&
        owner.hostBootId !== identity.hostBootId;
      if (otherBoot || now - modified > FOREIGN_ATTEMPT_MAX_AGE_MS)
        this.removeAttempt(directory, owner);
    }
    // While a lease is held, a full survey could refuse on another live attempt, so
    // drop just what this pass released; a held build must not keep paying for it.
    this.unresolved = this.held
      ? this.unresolved.filter((attempt) => {
          const directory = join(this.root, attempt.attempt);
          if (!existsSync(directory)) return false;
          return attempt.operation === 'local' || this.readRemoteRecord(directory) !== undefined;
        })
      : this.survey(namespace);
    return this.unresolvedAttempts();
  }

  private acquireLease(
    admissionMarker: string | undefined,
    releaseAdmission: () => void,
    retainAdmission: () => void,
  ): BuildStorageLease {
    if (this.held)
      throw new Error(
        'Build storage busy: another project is staging, building or importing an image. Retry when it finishes.',
      );
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const namespace = readlinkSync('/proc/self/ns/pid');
    try {
      this.unresolved = this.survey(namespace);
    } catch (cause) {
      throw new Error(
        'Build storage recovery could not establish that an old attempt is inactive; inspect its owner and command records before reconciliation',
        { cause },
      );
    }
    this.check(2 * GiB, false);
    const directory = mkdtempSync(join(this.root, 'attempt-'));
    const identity = this.hostIdentity();
    try {
      writeFileSync(
        join(directory, 'owner.json'),
        JSON.stringify({
          version: 1,
          pid: process.pid,
          namespace,
          start: processStart(process.pid),
          ...(identity === undefined ? {} : { hostBootId: identity.hostBootId }),
          ...(admissionMarker === undefined ? {} : { admissionMarker }),
        }),
        { mode: 0o600 },
      );
    } catch (cause) {
      rmSync(directory, { recursive: true, force: true });
      throw cause;
    }
    this.held = true;
    this.currentDirectory = directory;
    activeDirectories.add(directory);
    let commandIndex = 0;
    let running = false;
    let disposed = false;
    let reserved = false;
    let estimateBytes: number | undefined;
    const remoteRecord = join(directory, 'remote-operation.json');
    const syncDirectory = () => {
      const fd = openSync(directory, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    };
    return {
      directory,
      get retainArtifacts() {
        return existsSync(remoteRecord);
      },
      reserveBuild: (imageBytes) => {
        if (disposed) throw new Error('Build storage lease was released');
        estimateBytes = estimateBuildStorageBytes(this.policy, imageBytes);
        this.check(estimateBytes, true);
        reserved = true;
      },
      run: async (command, args, options) => {
        if (disposed || running) throw new Error('Build storage command lease is not available');
        if (options.remoteOperation !== undefined) {
          if (existsSync(remoteRecord))
            throw new Error(
              'Remote operation termination is unconfirmed; this attempt cannot start another remote operation',
            );
          // Persist before spawning: a Server crash must never turn an unknown
          // remote solve/import into a positively abandoned local-only attempt.
          // The record names the host so reconciliation can prove its boot ended.
          // Without that identity no such proof is possible, and the work proceeds
          // as an unmanaged build would rather than not at all. Read on its own: a
          // malformed measurement must not discard a valid identity and with it the
          // record that keeps uncertain work reserved.
          const report = this.hostIdentity();
          if (report === undefined) {
            if (!this.warnedRemoteRecord) {
              this.warnedRemoteRecord = true;
              console.warn(
                'Build storage has no host identity in the storage report; remote build work runs without a durable recovery record.',
              );
            }
          } else {
            writeFileSync(
              remoteRecord,
              JSON.stringify({
                version: 1,
                operation: options.remoteOperation,
                hostBootId: report.hostBootId,
                hostIdentity: report.hostIdentity,
                startedAt: new Date().toISOString(),
                ...(estimateBytes === undefined ? {} : { estimateBytes }),
              }),
              { mode: 0o600, flag: 'wx', flush: true },
            );
            syncDirectory();
            for (const path of [this.root, dirname(this.root)]) {
              const rootFd = openSync(path, 'r');
              try {
                fsyncSync(rootFd);
              } finally {
                closeSync(rootFd);
              }
            }
          }
        }
        running = true;
        try {
          const result = await new Promise<{ stdout: string; stderr: string }>(
            (resolve, reject) => {
              // The child records its group before executing any command. If the
              // Server dies before that write, recovery can remove the attempt:
              // set -e then prevents a late child from starting unreserved work.
              const child = spawn(
                'bash',
                [
                  '-c',
                  'set -e; printf "%s\\n" "$$" > "$1"; shift; exec "$@"',
                  'verity-build-command',
                  join(directory, `child-${commandIndex++}`),
                  command,
                  ...args,
                ],
                {
                  env: options.env,
                  ...(options.signal === undefined ? {} : { signal: options.signal }),
                  detached: true,
                  stdio: ['ignore', 'pipe', 'pipe'],
                },
              );
              let failure: unknown;
              const stdout: Buffer[] = [];
              const stderr: Buffer[] = [];
              let outputBytes = 0;
              const terminate = () => {
                if (child.pid === undefined) return;
                try {
                  process.kill(-child.pid, 'SIGKILL');
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error;
                }
              };
              const collect = (chunks: Buffer[], chunk: Buffer) => {
                const remaining = Math.max(0, options.maxBuffer - outputBytes);
                outputBytes += chunk.length;
                if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
                if (outputBytes > options.maxBuffer) {
                  failure ??= new Error('Build command output exceeded its buffer limit');
                  terminate();
                }
              };
              child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
              child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
              child.once('error', (error) => {
                failure ??= error;
                // AbortSignal only sends SIGTERM to the leader. Terminate the
                // whole group even when that leader ignores the signal.
                terminate();
              });
              const timeout = setTimeout(() => {
                failure ??= new Error('Build command timed out');
                terminate();
              }, options.timeout);
              timeout.unref();
              const monitor = setInterval(() => {
                if (!reserved) return;
                try {
                  this.check(0, true);
                } catch (error) {
                  failure ??= error;
                  terminate();
                }
              }, 2000);
              monitor.unref();
              // Kill descendants even if the command's leader exits first.
              child.once('exit', terminate);
              child.once('close', (code, signal) => {
                clearTimeout(timeout);
                clearInterval(monitor);
                const output = {
                  stdout: Buffer.concat(stdout).toString('utf8'),
                  stderr: Buffer.concat(stderr).toString('utf8'),
                };
                if (failure !== undefined || code !== 0) {
                  const reason =
                    failure instanceof Error
                      ? failure
                      : new Error(`Build command exited ${code ?? signal}`);
                  // Exited on its own with a status, rather than killed by a timeout,
                  // a buffer limit, an abort or a failed space check.
                  const exited = failure === undefined && code !== null;
                  reject(
                    Object.assign(reason, {
                      ...output,
                      stderr: `${output.stderr}\n${reason.message}`,
                      [EXITED]: exited,
                    }),
                  );
                } else resolve(output);
              });
            },
          );
          if (options.remoteOperation !== undefined && existsSync(remoteRecord)) {
            unlinkSync(remoteRecord);
            syncDirectory();
          }
          return result;
        } catch (error) {
          // A definitive failure is the remote side's own final answer: nothing of
          // the operation can still run, so it must not hold admission or files.
          const output = error as { stdout?: string; stderr?: string; [EXITED]?: boolean };
          if (
            options.remoteOperation !== undefined &&
            output[EXITED] === true &&
            existsSync(remoteRecord) &&
            remoteOperationEnded(
              options.remoteOperation,
              `${output.stdout ?? ''}\n${output.stderr ?? ''}`,
            )
          ) {
            unlinkSync(remoteRecord);
            syncDirectory();
          }
          throw error;
        } finally {
          running = false;
        }
      },
      dispose: () => {
        if (disposed) return;
        if (running) throw new Error('Cannot release storage while a build command is running');
        if (!existsSync(remoteRecord)) rmSync(directory, { recursive: true, force: true });
        if (existsSync(remoteRecord)) retainAdmission();
        else releaseAdmission();
        disposed = true;
        this.held = false;
        this.currentDirectory = undefined;
        activeDirectories.delete(directory);
        this.wakeNext();
      },
    };
  }
}
