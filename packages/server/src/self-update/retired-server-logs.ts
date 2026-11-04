import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitizeDiagnostic } from '../build-diagnostics.js';
import type { DockerClient } from '../docker.js';

/** Directory under the Updater-owned managed root that keeps retired Servers' logs. */
export const RETIRED_SERVER_LOG_DIR = 'server-logs';
/** A retired generation's logs leave with its container; keep the last few. */
const KEEP = 2;
const WINDOW_MS = 24 * 60 * 60_000;
/** The Engine logs endpoint returns at most this many lines per read. */
const TAIL_LINES = 1000;
const NAME = /^verity-managed-server(?:-g[1-9][0-9]{0,9})?$/u;

/**
 * Copy a bounded, redacted tail of a Server container's logs next to the managed
 * deployment before the container is removed. Docker drops a container's logs
 * with the container, so without this the lines around a failed or just-finished
 * update are gone once the old generation is retired.
 *
 * Best effort by contract: it never throws, because keeping evidence must not
 * keep a stopped Server (and the repair-blocking second container) around.
 */
export async function archiveRetiredServerLogs(options: {
  readonly managedRoot: string;
  readonly docker: Pick<DockerClient, 'containerLogs'>;
  readonly containerId: string;
  readonly containerName: string;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}): Promise<void> {
  const now = options.now ?? Date.now;
  try {
    if (!NAME.test(options.containerName) || options.docker.containerLogs === undefined) return;
    const until = now();
    const raw = await options.docker.containerLogs(options.containerId, TAIL_LINES, {
      since: new Date(until - WINDOW_MS).toISOString(),
      until: new Date(until).toISOString(),
    });
    const dir = join(options.managedRoot, RETIRED_SERVER_LOG_DIR);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const target = join(dir, `${options.containerName}.log`);
    const temporary = `${target}.${String(process.pid)}.tmp`;
    await writeFile(temporary, sanitizeDiagnostic(raw), { mode: 0o600 });
    await rename(temporary, target);
    await prune(dir);
  } catch (error) {
    options.log?.(
      `Could not keep the logs of ${options.containerName}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

async function prune(dir: string): Promise<void> {
  const files = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.log') || !NAME.test(name.slice(0, -'.log'.length))) continue;
    files.push({ name, modified: (await stat(join(dir, name))).mtimeMs });
  }
  files.sort((a, b) => b.modified - a.modified);
  for (const file of files.slice(KEEP)) await rm(join(dir, file.name), { force: true });
}
