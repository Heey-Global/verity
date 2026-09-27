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
/** The lock wait left for a postCreateCommand once the provisioner's own wait for
 *  the install already ran out: that install is wedged, and waiting the full bound
 *  a second time would only double how long the provision hangs before it says so. */
export const NODE_MODULES_INSTALL_LOCK_WAIT_AFTER_TIMEOUT_SECONDS = 60;
/** flock's exit code when that wait runs out, picked to be distinguishable from
 *  any exit code the postCreateCommand itself plausibly returns. */
const NODE_MODULES_INSTALL_LOCK_TIMEOUT_EXIT = 75;
/** Container env that turns `verity-node-modules-install` off (`=0`). Set when
 *  the devcontainer mounts node_modules itself: that volume is the project's, and
 *  so is installing into it. Opt-out, so a Sandbox created before it existed
 *  keeps installing into the managed volume it has. */
export const NODE_MODULES_INSTALL_ENV = 'VERITY_NODE_MODULES_INSTALL';
/** The file `verity-node-modules-install` writes into node_modules once an install
 *  finished, and checks on every start before installing again. */
export const NODE_MODULES_INSTALL_COMPLETE_MARKER = '.verity-install-complete';

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
 * (`npm ci` is the common one) then wrote the same tree concurrently, and the two
 * failed each other with ENOTEMPTY on rmdir. The provision failed, the container
 * was removed, the volume kept the half-written tree, and every repair replayed
 * the same race. Under the lock, an install that starts later steps aside.
 *
 * A successful command that reinstalled (npm's hidden lockfile is there) also
 * emptied the install's completion marker with the rest of the tree; it is put
 * back, or the next start would reinstall a tree that is already complete. Only
 * if it was there before the command: npm writes that hidden lockfile before
 * lifecycle scripts run, so after a failed install it is present without the
 * marker, and a command that never touched node_modules must not certify that
 * half-written tree as complete — no later start would ever repair it.
 *
 * Without a real node_modules directory or without flock (the install script
 * cannot run then either) the command runs as before.
 */
export function underNodeModulesInstallLock(
  command: string,
  nodeModules: string,
  waitSeconds: number = NODE_MODULES_INSTALL_LOCK_WAIT_SECONDS,
): string {
  const dir = shellQuote(nodeModules);
  const inner = `sh -c ${shellQuote(command)}`;
  const exit = String(NODE_MODULES_INSTALL_LOCK_TIMEOUT_EXIT);
  const marker = shellQuote(`${nodeModules}/${NODE_MODULES_INSTALL_COMPLETE_MARKER}`);
  const hiddenLockfile = shellQuote(`${nodeModules}/.package-lock.json`);
  return [
    `if [ -d ${dir} ] && [ ! -L ${dir} ] && command -v flock >/dev/null 2>&1; then`,
    `  flock -w ${String(waitSeconds)} -E ${exit} ${dir} sh -c ${shellQuote(
      `completed=0; if [ -e ${marker} ]; then completed=1; fi; ${inner} || exit; ` +
        `if [ "$completed" = 1 ] && [ -e ${hiddenLockfile} ] && [ ! -e ${marker} ]; then touch ${marker} || true; fi`,
    )}; rc=$?;`,
    `  if [ "$rc" -eq ${exit} ]; then echo "timed out waiting for the dependency install holding ${nodeModules}" >&2; fi;`,
    `  exit "$rc";`,
    `fi;`,
    inner,
  ].join('\n');
}

/** Runs the node_modules install to completion, or waits for the one already
 *  running, before a postCreateCommand: that command must find the dependencies
 *  in place whatever it does itself. Absent from images without the toolkit. */
export const NODE_MODULES_INSTALL_WAIT_COMMAND =
  'if command -v verity-node-modules-install >/dev/null 2>&1; then verity-node-modules-install --wait; fi';
