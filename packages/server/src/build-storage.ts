import { spawn, spawnSync } from 'node:child_process';
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
import { dirname, join } from 'node:path';
import { z } from 'zod';

const GiB = 1024 ** 3;
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
const ownerSchema = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  namespace: z.string(),
  start: z.string(),
});

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
    // Unknown/native builds are deliberately expensive. This is an admission
    // estimate, never a claim that cache GC bounds active snapshot growth.
    // Allowances: context 2 + snapshots 256 + archive 16 + import 32 GiB.
    estimateBytes: positive('VERITY_BUILD_ESTIMATE_GIB', 2 + 256 + 16 + 32) * GiB,
    reserveBytes: positive('VERITY_BUILD_FREE_GIB', 10) * GiB,
    reserveInodes: positive('VERITY_BUILD_FREE_INODES', 1_000_000, 12),
  };
}

export interface BuildStorageLease {
  directory: string;
  /** Remote work may still use the context or archive; preserve both and admission. */
  readonly retainArtifacts: boolean;
  reserveBuild(): void;
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

/** One active Server owns an Engine, as with derived-image collection. All
 * projects share this admission gate, including context staging and import.
 * Recovery only removes positively identified abandoned attempts; ambiguous
 * records or a changed PID namespace block admission instead of risking data.
 */
export class BuildStorage {
  private held = false;
  private warnedUnprovisioned = false;
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
    const local = this.localDisk();
    let available = local.availableBytes;
    let inodes = local.freeInodes;
    if (host) {
      let report: z.infer<typeof reportSchema>;
      try {
        const input = readFileSync(this.reportFile, 'utf8');
        if (input.length > 262144) unavailable('host storage report exceeds its size limit');
        report = reportSchema.parse(JSON.parse(input));
      } catch {
        unavailable('host storage report is missing or invalid');
      }
      const age = Date.now() - Date.parse(report.observedAt);
      if (age < -5000 || age > 120_000) unavailable('host storage report is stale');
      for (const kind of ['buildkit', 'docker', 'containerd', 'export', 'project']) {
        const roots = report.roots.filter((root) => root.kind === kind);
        const root = roots[0];
        if (
          roots.length !== 1 ||
          root?.state !== 'available' ||
          root.availableBytes === undefined ||
          root.freeInodes === undefined ||
          root.filesystemId === undefined
        )
          unavailable(`${kind} filesystem is not established`);
        const rootAge =
          root.observedAt === undefined ? Infinity : Date.now() - Date.parse(root.observedAt);
        if (rootAge < -5000 || rootAge > 120_000)
          unavailable(`${kind} filesystem sample is stale or missing`);
        // Treat all roots as aliases for admission. Summing independent free
        // budgets would over-admit on the common single-host-filesystem layout.
        available = Math.min(available, root.availableBytes);
        inodes = Math.min(inodes, root.freeInodes);
      }
    }
    if (available < bytes + this.policy.reserveBytes || inodes < this.policy.reserveInodes) {
      throw new Error(
        `Build storage admission rejected: available ${Math.floor(available / GiB)} GiB and ${inodes} free inodes; requires ${Math.ceil(bytes / GiB)} GiB estimated growth plus ${Math.ceil(this.policy.reserveBytes / GiB)} GiB reserve and ${this.policy.reserveInodes} free inodes. Retry after capacity is available or configure an estimate supported by bounded build measurements.`,
      );
    }
  }

  /**
   * The Provisioner's entry point. Returns no lease on a host without managed
   * admission: the build then takes the unmanaged path it took before
   * admission existed. Host storage reports and the lock come from the same
   * host installation, so neither can be required where the other was never
   * provisioned. Every other state that is not a held shared lock fails closed.
   */
  admit(): BuildStorageLease | undefined {
    if (this.admissionDirectory !== undefined) {
      const admission = this.admissionState(this.admissionDirectory);
      if (admission.state === 'not-provisioned') {
        if (!this.warnedUnprovisioned) {
          this.warnedUnprovisioned = true;
          console.warn(builderAdmissionMessage(admission));
        }
        return undefined;
      }
    }
    return this.acquire();
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

  private acquireLease(
    releaseAdmission: () => void,
    retainAdmission: () => void,
  ): BuildStorageLease {
    if (this.held)
      throw new Error(
        'Build storage busy: another project is staging, building or importing an image. Retry when it finishes.',
      );
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const namespace = readlinkSync('/proc/self/ns/pid');
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.name.startsWith('attempt-')) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) unavailable('unrecognized attempt entry');
      const directory = join(this.root, entry.name);
      if (existsSync(join(directory, 'remote-operation.json')))
        unavailable(
          `remote build/import termination is unconfirmed for ${entry.name}; admission and owned files remain reserved, including across restart. Follow deploy/buildkit/README.md offline reconciliation; do not delete reservation records`,
        );
      try {
        const owner = ownerSchema.parse(
          JSON.parse(readFileSync(join(directory, 'owner.json'), 'utf8')),
        );
        if (owner.namespace !== namespace)
          unavailable(
            'abandoned attempt belongs to another PID namespace; host reconciliation is required',
          );
        if (existsProcess(owner.pid) && processStart(owner.pid) === owner.start) {
          unavailable('a previous build process still owns its reservation');
        }
        for (const file of readdirSync(directory)) {
          if (!/^child-\d+$/.test(file)) continue;
          const pid = Number(readFileSync(join(directory, file), 'utf8').trim());
          if (!Number.isSafeInteger(pid) || pid <= 1 || existsProcess(-pid)) {
            unavailable('an abandoned build command may still be running');
          }
        }
        rmSync(directory, { recursive: true });
      } catch (cause) {
        throw new Error(
          'Build storage recovery could not establish that an old attempt is inactive; inspect its owner and command records before reconciliation',
          { cause },
        );
      }
    }
    this.check(2 * GiB, false);
    const directory = mkdtempSync(join(this.root, 'attempt-'));
    try {
      writeFileSync(
        join(directory, 'owner.json'),
        JSON.stringify({
          version: 1,
          pid: process.pid,
          namespace,
          start: processStart(process.pid),
        }),
        { mode: 0o600 },
      );
    } catch (cause) {
      rmSync(directory, { recursive: true, force: true });
      throw cause;
    }
    this.held = true;
    let commandIndex = 0;
    let running = false;
    let disposed = false;
    let reserved = false;
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
      reserveBuild: () => {
        if (disposed) throw new Error('Build storage lease was released');
        this.check(this.policy.estimateBytes, true);
        reserved = true;
      },
      run: async (command, args, options) => {
        if (disposed || running) throw new Error('Build storage command lease is not available');
        if (options.remoteOperation !== undefined) {
          if (existsSync(remoteRecord))
            throw new Error(
              'Remote operation termination is unconfirmed; offline reconciliation is required',
            );
          // Persist before spawning: a Server crash must never turn an unknown
          // remote solve/import into a positively abandoned local-only attempt.
          const report = reportSchema.parse(JSON.parse(readFileSync(this.reportFile, 'utf8')));
          if (report.hostBootId === undefined || report.hostIdentity === undefined)
            unavailable(
              'host identity is missing; repair the host storage reporter before remote work',
            );
          writeFileSync(
            remoteRecord,
            JSON.stringify({
              version: 1,
              operation: options.remoteOperation,
              hostBootId: report.hostBootId,
              hostIdentity: report.hostIdentity,
              startedAt: new Date().toISOString(),
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
                  reject(
                    Object.assign(reason, {
                      ...output,
                      stderr: `${output.stderr}\n${reason.message}`,
                    }),
                  );
                } else resolve(output);
              });
            },
          );
          if (options.remoteOperation !== undefined) {
            unlinkSync(remoteRecord);
            syncDirectory();
          }
          return result;
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
      },
    };
  }
}
