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
