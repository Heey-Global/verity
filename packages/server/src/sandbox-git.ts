import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitOutput } from './branches.js';
import { DockerError } from './docker.js';
import { containerPathFor, dockerHostFor } from './project-backend.js';

const execFileAsync = promisify(execFile);

/**
 * Runs git INSIDE a project's sandbox container instead of on the server.
 *
 * A project clone is bind-mounted read-write into its sandbox, so a session owns the
 * repository's `.git/config` — and several config keys name a program git then runs
 * (`filter.<name>.clean`, `merge.<name>.driver`, `diff.<name>.textconv`, hooks, the
 * fsmonitor). A server-side `git merge` against that repository therefore executes
 * code the sandbox chose, OUTSIDE the sandbox. Fixed-name keys can be pinned away on
 * argv, but the name-carrying ones cannot: a denylist scan is read-then-run, and a
 * live sandbox process can install a filter between the scan and the merge.
 *
 * Routing the command into the container removes the question rather than answering
 * it. Whatever git runs there is a program the sandbox could already have run itself,
 * with the sandbox's own filesystem, network, and privileges — the very thing the
 * boundary exists to allow. It also fixes ownership as a side effect: files the merge
 * writes into `/work` belong to the container user, exactly like an agent's commits,
 * rather than to whichever uid the server happens to run as.
 *
 * The exec shape deliberately mirrors {@link DockerExecBackend}, which is how agent
 * processes already reach the container: `docker exec -w <root> <container> git …`,
 * argv straight through with no shell in between, and no `--user` override, so the
 * command runs as the container's own user.
 */

/** Runs a command and resolves its stdout; injected so tests can assert argv without
 *  a docker daemon. Rejects on a non-zero exit, carrying `stdout`/`stderr` the way
 *  `execFile` does — {@link createSandboxGit} depends on that to classify failures. */
export type SandboxExec = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * The project's sandbox could not run the command — it is stopped, gone, or the
 * docker daemon is unreachable. Raised INSTEAD of a git failure: every git command in
 * the merge path treats a rejection as a repository fact ("not an ancestor", "no such
 * branch"), so a container that is simply not running must be distinguishable, or it
 * would be reported to the operator as a merge conflict or a detached base.
 */
export class SandboxUnavailableError extends Error {
  constructor(
    readonly containerName: string,
    cause?: unknown,
  ) {
    super(`the project sandbox is not available`);
    this.name = 'SandboxUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** Asks the daemon about the sandbox container — `inspectContainer` narrowed to the
 *  one field this module reads. Rejects the way {@link DockerClient} does: a
 *  {@link DockerError} of kind `container_not_found` when the container is gone,
 *  `network` when the daemon is unreachable. */
export type SandboxInspect = () => Promise<{ running: boolean }>;

export interface SandboxGitOptions {
  /** The project's sandbox container. */
  containerName: string;
  /** How a failure is classified: see {@link sandboxIsDown}. Required, because the
   *  alternative — reading the failed command's own stderr — lets the repository
   *  choose the classification. */
  inspect: SandboxInspect;
  /** Host path of the project clone; every path in argv must be at or under it. */
  hostRoot: string;
  /** Where that clone is mounted in the container. Default `/work`. */
  containerRoot?: string | undefined;
  /** Docker API base URL, translated to `DOCKER_HOST` for the CLI. */
  dockerBaseUrl?: string | undefined;
  dockerCommand?: string | undefined;
  exec?: SandboxExec | undefined;
}

const defaultExec: SandboxExec = async (command, args, options) => {
  const { stdout, stderr } = await execFileAsync(command, [...args], options);
  return { stdout, stderr };
};

/**
 * Rewrite the HOST paths in a git argv to their container equivalents.
 *
 * Only the two positions that carry a path are touched — `-C <path>` and
 * `--work-tree=<path>`. Everything else (branch names, refs, `--`) passes through
 * byte-for-byte: a blanket "replace the prefix anywhere" would also rewrite a branch
 * whose NAME happens to start with the clone path, which is attacker-chosen text.
 *
 * A path outside the clone throws rather than being passed through — it would resolve
 * to a different repository inside the container, or to nothing at all.
 */
export function containerGitArgs(
  args: readonly string[],
  hostRoot: string,
  containerRoot = '/work',
): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === '-C') {
      const path = args[index + 1];
      if (path === undefined) throw new Error('git -C is missing its path');
      out.push('-C', containerPathFor(path, hostRoot, containerRoot));
      index += 1;
      continue;
    }
    if (arg.startsWith('--work-tree=')) {
      const path = arg.slice('--work-tree='.length);
      out.push(`--work-tree=${containerPathFor(path, hostRoot, containerRoot)}`);
      continue;
    }
    out.push(arg);
  }
  return out;
}

/**
 * Whether the sandbox — not git — is what failed, decided by asking the daemon.
 *
 * Never decided from the failed command's output. `docker exec` forwards the container
 * process's exit status AND merges its stderr into its own, so a merge driver, hook, or
 * filter the repository names can exit non-zero while printing `Error response from
 * daemon: … is not running`. Reading that text would let a repository pick its own
 * classification, and this is the one classification that means "the merge never ran,
 * the base is untouched" — the answer that skips the rollback in `mergeIntoLocalBase`.
 *
 * A probe that fails for any other reason answers `false`: staying a git failure keeps
 * the diagnostics and the rollback, which is the safe direction to be wrong in. The
 * cost of guessing wrong that way is a sanitized 500 instead of "start the project".
 *
 * What `true` does NOT establish is that the command never ran: the container can also
 * go away moments after git wrote something. A caller whose command leaves state behind
 * has to answer that from the repository itself — see `mergeInProgress` in `branches.ts`,
 * which reads it off the disk precisely because no probe through the sandbox is left.
 */
async function sandboxIsDown(inspect: SandboxInspect): Promise<boolean> {
  try {
    return !(await inspect()).running;
  } catch (error) {
    if (!(error instanceof DockerError)) return false;
    return error.kind === 'container_not_found' || error.kind === 'network';
  }
}

/**
 * A {@link GitOutput} that runs each invocation in the project's sandbox.
 *
 * Failures keep git's contract — a non-zero exit rejects, carrying stderr — because
 * callers classify on it (a conflicted merge, an absent ref). A failure the daemon
 * confirms is the container's absence becomes {@link SandboxUnavailableError} instead,
 * so "the sandbox is stopped" never reaches the operator disguised as a repository
 * problem. Confirming costs one inspect per FAILED command, which is the rare case.
 */
export function createSandboxGit(opts: SandboxGitOptions): GitOutput {
  const exec = opts.exec ?? defaultExec;
  const containerRoot = opts.containerRoot ?? '/work';
  const dockerHost =
    opts.dockerBaseUrl !== undefined ? dockerHostFor(opts.dockerBaseUrl) : undefined;
  return async (args) => {
    const inContainer = containerGitArgs(args, opts.hostRoot, containerRoot);
    try {
      const { stdout } = await exec(
        opts.dockerCommand ?? 'docker',
        [
          'exec',
          // The clone root, not the command's own `-C` target: `-C` already carries
          // it, and a workdir that no longer exists would fail the exec itself.
          '-w',
          containerRoot,
          opts.containerName,
          'git',
          ...inContainer,
        ],
        {
          env: { ...process.env, ...(dockerHost !== undefined ? { DOCKER_HOST: dockerHost } : {}) },
        },
      );
      return stdout;
    } catch (error) {
      if (await sandboxIsDown(opts.inspect)) {
        throw new SandboxUnavailableError(opts.containerName, error);
      }
      throw error;
    }
  };
}
