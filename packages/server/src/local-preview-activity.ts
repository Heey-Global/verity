import { DockerError } from './docker.js';
import { PreviewShareConflictError } from './preview-network-policy.js';

const STATIC_TARGET_FAILURES = new Set([
  'static publish directory does not exist or is not a safe directory',
  'project checkout does not exist',
  'session worktree does not exist',
  'session worktree is outside the project checkout',
]);

/** Ownership absence is authoritative; Docker/exec timeouts are not. */
export function localTargetConfirmedMissing(error: unknown): boolean {
  if (error instanceof DockerError) return error.kind === 'container_not_found';
  if (!(error instanceof PreviewShareConflictError)) return false;
  if (error.message === 'nothing in this session listens on that port') return true;
  if (STATIC_TARGET_FAILURES.has(error.message)) {
    const visited = new Set<Error>();
    let cause = error.cause;
    while (cause instanceof Error && !visited.has(cause)) {
      visited.add(cause);
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== undefined) return code === 'ENOENT' || code === 'ENOTDIR';
      if (
        cause.message === 'unsafe static directory' ||
        cause.message === 'static path contains a symlink'
      )
        return true;
      cause = cause.cause;
    }
    return false;
  }
  return error.message === 'sandbox is not running' || error.message === 'project is not active';
}
