import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const GiB = 1024 ** 3;
const reportSchema = z.object({
  schemaVersion: z.literal(1),
  observedAt: z.iso.datetime(),
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
  reserveBuild(): void;
  run(
    this: void,
    command: string,
    args: string[],
    options: {
      env: NodeJS.ProcessEnv;
      signal?: AbortSignal;
      timeout: number;
      maxBuffer: number;
    },
  ): Promise<{ stdout: string; stderr: string }>;
  dispose(): void;
}

/** One active Server owns an Engine, as with derived-image collection. All
 * projects share this admission gate, including context staging and import.
 * Recovery only removes positively identified abandoned attempts; ambiguous
 * records or a changed PID namespace block admission instead of risking data.
 */
export class BuildStorage {
  private held = false;
  constructor(
    readonly root: string,
    private readonly reportFile = '/run/verity-host-diagnostics/storage.json',
    private readonly policy = buildStoragePolicy(),
    private readonly localDisk = () => {
      const stats = statfsSync(this.root);
      return { availableBytes: stats.bavail * stats.bsize, freeInodes: stats.ffree };
    },
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

  acquire(): BuildStorageLease {
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
    return {
      directory,
      reserveBuild: () => {
        if (disposed) throw new Error('Build storage lease was released');
        this.check(this.policy.estimateBytes, true);
        reserved = true;
      },
      run: async (command, args, options) => {
        if (disposed || running) throw new Error('Build storage command lease is not available');
        running = true;
        try {
          return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
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
          });
        } finally {
          running = false;
        }
      },
      dispose: () => {
        if (disposed) return;
        if (running) throw new Error('Cannot release storage while a build command is running');
        rmSync(directory, { recursive: true, force: true });
        disposed = true;
        this.held = false;
      },
    };
  }
}
