import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CONTAINER_COMMAND_BASE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const DEVCONTAINER_POST_CREATE_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export type ContainerCommandRunner = (args: {
  containerName: string;
  command: string;
  dockerHost: string;
  user?: string | undefined;
  workdir?: string | undefined;
  timeoutMs?: number | undefined;
}) => Promise<{ stdout: string; stderr: string }>;

export function devcontainerLifecyclePath(user: string | undefined): string {
  if (user === 'root') return `/root/.local/bin:${CONTAINER_COMMAND_BASE_PATH}`;
  if (user !== undefined && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(user)) {
    return `/home/${user}/.local/bin:${CONTAINER_COMMAND_BASE_PATH}`;
  }
  return CONTAINER_COMMAND_BASE_PATH;
}

export function devcontainerLifecycleCommand(user: string | undefined, command: string): string {
  const clearVerityHooks =
    'git config --global --unset-all core.hooksPath 2>/dev/null || true; ' +
    'git config --local --unset-all core.hooksPath 2>/dev/null || true';
  return `PATH=${devcontainerLifecyclePath(user)}; export PATH; ${clearVerityHooks}; ${command}`;
}

export const defaultContainerCommandRunner: ContainerCommandRunner = async ({
  containerName,
  command,
  dockerHost,
  user,
  workdir = '/work',
  timeoutMs,
}) =>
  execFileAsync(
    'docker',
    [
      'exec',
      ...(user !== undefined && user.length > 0 ? ['--user', user] : []),
      '--env',
      `PATH=${devcontainerLifecyclePath(user)}`,
      '-w',
      workdir,
      containerName,
      'sh',
      '-lc',
      devcontainerLifecycleCommand(user, command),
    ],
    {
      env: { ...process.env, DOCKER_HOST: dockerHost },
      maxBuffer: DEVCONTAINER_POST_CREATE_MAX_BUFFER_BYTES,
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    },
  );

/** How long a postCreateCommand waits for the dependency install it shares
 *  node_modules with before failing the provision with a message that says so. */
export const NODE_MODULES_INSTALL_LOCK_WAIT_SECONDS = 1800;
/** flock's exit code when that wait runs out, picked to be distinguishable from
 *  any exit code the postCreateCommand itself plausibly returns. */
const NODE_MODULES_INSTALL_LOCK_TIMEOUT_EXIT = 75;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs `command` while holding the lock `verity-node-modules-install` takes on
 * `nodeModules` (the directory itself: it is the mount point, so `npm ci` empties
 * it but never removes it, and every user can open it).
 *
 * `verity-runner-stack-start` launches that install in the background whenever
 * something is mounted at /work/node_modules, and returns before it finishes; the
 * postCreateCommand runs right after. A postCreateCommand that installs too
 * (`npm ci` is the common one) then writes the same tree concurrently, and the
 * two fail each other with ENOTEMPTY on rmdir. The provision fails, the container
 * is removed, the volume keeps the half-written tree, and every repair replays
 * the same race. Holding the lock makes the command wait for an install already
 * running, and makes an install that starts later step aside.
 *
 * Without a real node_modules directory or without flock (the install script
 * cannot run then either) the command runs as before.
 */
export function underNodeModulesInstallLock(command: string, nodeModules: string): string {
  const dir = shellQuote(nodeModules);
  const inner = `sh -c ${shellQuote(command)}`;
  const exit = String(NODE_MODULES_INSTALL_LOCK_TIMEOUT_EXIT);
  return [
    `if [ -d ${dir} ] && [ ! -L ${dir} ] && command -v flock >/dev/null 2>&1; then`,
    `  flock -w ${String(NODE_MODULES_INSTALL_LOCK_WAIT_SECONDS)} -E ${exit} ${dir} ${inner}; rc=$?;`,
    `  if [ "$rc" -eq ${exit} ]; then echo "timed out waiting for the dependency install holding ${nodeModules}" >&2; fi;`,
    `  exit "$rc";`,
    `fi;`,
    inner,
  ].join('\n');
}
