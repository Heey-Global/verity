import { execFile, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { builderAdmissionMessage, type BuilderAdmissionState } from './builder-admission.js';
import type { BuildStorageLease } from './build-storage.js';

type RunOptions = Parameters<BuildStorageLease['run']>[2];
interface Options {
  root: string;
  admissionDirectory: string;
  owner(): { version: 1; pid: number; namespace: string; start: string; hostBootId: string };
  hostIdentity(): { hostBootId: string; hostIdentity: string } | undefined;
  acquired(directory: string): void;
  disposed(directory: string): void;
  liveChild(directory: string): boolean;
  admissionState(): BuilderAdmissionState;
  createAdmissionMarker(): string;
  remoteOperationEnded(
    operation: NonNullable<RunOptions['remoteOperation']>,
    output: string,
  ): boolean;
  validateProtectedBuild(value: NonNullable<RunOptions['protectedBuild']>): object;
}
const execute = promisify(execFile);

/** Legacy hosts still need a durable writer journal, even without host admission. */
export function createUnmanagedBuildLease(options: Options): BuildStorageLease {
  mkdirSync(options.root, { recursive: true, mode: 0o700 });
  const journal = mkdtempSync(join(options.root, 'attempt-unmanaged-'));
  let owner: ReturnType<Options['owner']>;
  try {
    owner = options.owner();
    writeFileSync(join(journal, 'owner.json'), JSON.stringify(owner), { mode: 0o600, flush: true });
  } catch (error) {
    rmSync(journal, { recursive: true, force: true });
    throw error;
  }
  options.acquired(journal);
  let admissionFd: number | undefined;
  let admissionMarker: string | undefined;
  let running = false;
  let commandIndex = 0;
  let disposed = false;
  const remotePaths = () =>
    [journal, ...(admissionMarker ? [admissionMarker] : [])].map((directory) =>
      join(directory, 'remote-operation.json'),
    );
  const remotePending = () => remotePaths().some((path) => existsSync(path));
  const enterProvisionedHost = () => {
    const admission = options.admissionState();
    if (admission.state === 'not-provisioned') return;
    if (admission.state !== 'provisioned')
      throw new Error(`Builder admission unavailable: ${builderAdmissionMessage(admission)}`);
    const fd = openSync(join(options.admissionDirectory, 'build-admission.lock'), 'r');
    try {
      const locked = spawnSync('flock', ['--shared', '--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'pipe', fd],
        timeout: 5000,
      });
      if (locked.status !== 0)
        throw new Error(
          'Builder admission unavailable: the host was provisioned during this build and its maintenance is in progress; retry the build',
        );
      if (existsSync(join(options.admissionDirectory, 'migration-pending')))
        throw new Error(
          'Builder admission unavailable: builder migration recovery is pending; retry the build',
        );
      admissionMarker = options.createAdmissionMarker();
      writeFileSync(join(journal, 'owner.json'), JSON.stringify({ ...owner, admissionMarker }), {
        mode: 0o600,
        flush: true,
      });
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    admissionFd = fd;
  };
  return {
    directory: tmpdir(),
    get retainArtifacts() {
      return remotePending();
    },
    reserveBuild: () => {},
    run: async (command, args, input) => {
      if (disposed || running) throw new Error('Build storage command lease is not available');
      if (input.remoteOperation !== undefined && admissionFd === undefined) enterProvisionedHost();
      if (remotePending())
        throw new Error('Remote operation termination is unconfirmed; retry after reconciliation');
      if (input.remoteOperation !== undefined) {
        const identity = options.hostIdentity();
        const record =
          identity === undefined
            ? {}
            : {
                version: 1,
                ...identity,
                operation: input.remoteOperation,
                ...(input.protectedBuild === undefined
                  ? {}
                  : { protectedBuild: options.validateProtectedBuild(input.protectedBuild) }),
                startedAt: new Date().toISOString(),
              };
        for (const path of remotePaths())
          writeFileSync(path, JSON.stringify(record), { mode: 0o600, flag: 'wx', flush: true });
      }
      // Publish the owner and remote record before a writer can escape this process.
      for (const directory of [journal, options.root, dirname(options.root)]) {
        const fd = openSync(directory, 'r');
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      running = true;
      const child = `child-${commandIndex++}`;
      try {
        const result = await execute(
          'setsid',
          [
            'bash',
            '-c',
            'set -e; printf "%s\\n" "$$" > "$1"; if [ -n "$2" ]; then printf "%s\\n" "$$" > "$2"; fi; shift 2; exec "$@"',
            'verity-build-command',
            join(journal, child),
            admissionMarker ? join(admissionMarker, child) : '',
            command,
            ...args,
          ],
          {
            env: input.env,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            timeout: input.timeout,
            maxBuffer: input.maxBuffer,
            encoding: 'utf8',
          },
        );
        for (const path of remotePaths()) rmSync(path, { force: true });
        return result;
      } catch (error) {
        const failure = error as {
          code?: unknown;
          killed?: boolean;
          stdout?: string;
          stderr?: string;
        };
        if (
          input.remoteOperation !== undefined &&
          typeof failure.code === 'number' &&
          !failure.killed &&
          options.remoteOperationEnded(
            input.remoteOperation,
            `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
          )
        )
          for (const path of remotePaths()) rmSync(path, { force: true });
        throw error;
      } finally {
        running = false;
      }
    },
    dispose: () => {
      if (disposed) return;
      if (running) throw new Error('Cannot release storage while a build command is running');
      disposed = true;
      try {
        if (
          !remotePending() &&
          !options.liveChild(journal) &&
          (admissionMarker === undefined || !options.liveChild(admissionMarker))
        ) {
          rmSync(journal, { recursive: true });
          if (admissionMarker) rmSync(admissionMarker, { recursive: true });
        }
      } finally {
        options.disposed(journal);
        if (admissionFd !== undefined) closeSync(admissionFd);
        admissionFd = undefined;
      }
    },
  };
}
