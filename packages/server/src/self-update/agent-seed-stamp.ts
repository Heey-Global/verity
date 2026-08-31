/**
 * Provenance for the agent-seed toolkit on the host.
 *
 * The seed is not part of the Server container. The provisioner binds a host
 * a concrete immutable release directory read-only over `/opt/agent-seed` in
 * every sandbox. Compose publishes the initial tree; in managed mode the
 * Updater republishes it from the exact sealed target digest before completing
 * companion reconciliation. A single atomic `.current` pointer selects a whole
 * validated tree, while an already-running sandbox retains its prior mount.
 *
 * The publisher writes the stamp before promotion; this module reads it back. Absent
 * means a seed published before stamping existed, which is a different
 * statement from "stale" and is kept distinct all the way to the operator.
 */

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

/** Written into the seed directory itself, so the seed carries its own origin. */
export const AGENT_SEED_STAMP_FILE = '.verity-agent-seed';

/**
 * Where the Updater sees the host seed directory.
 *
 * Fixed rather than configurable, because it is a mount target and not a host
 * path: `deploy/docker-compose.yml` binds `VERITY_AGENT_SEED_HOST_PATH` — whose
 * default is the same string — onto this path read-only, so an operator who
 * moves the directory on the host changes the source, never this.
 */
export const AGENT_SEED_MOUNT_PATH = '/opt/agent-seed';
export const AGENT_SEED_STAMP_VERSION = 1 as const;

/** Resolve the host source handed to new sandboxes. Managed seals created
 * before the immutable layout omit the suffix, so normalize them at runtime;
 * standalone deployments retain their configured path unchanged. */
export function sandboxAgentSeedHostPath(environment: NodeJS.ProcessEnv): string | undefined {
  const managedRoot = environment.VERITY_AGENT_SEED_ROOT_HOST_PATH;
  if (managedRoot !== undefined)
    return managedRoot.endsWith('/.current') ? managedRoot : join(managedRoot, '.current');
  const configured = environment.VERITY_AGENT_SEED_HOST_PATH;
  if ((environment.VERITY_MANAGED_DEPLOYMENT_ID ?? '').trim() === '') return configured;
  const root = configured ?? AGENT_SEED_MOUNT_PATH;
  return root.endsWith('/.current') ? root : join(root, '.current');
}

/**
 * Bounded so a corrupt or hostile file cannot be read into memory unbounded.
 * The real file is four short lines; anything approaching this is not a stamp.
 *
 * Enforced at the read, not after it: the process that reads this is the
 * Updater, which runs as root and is handed a host directory it does not own,
 * so a file that is enormous — or a fifo that never ends — must cost one bounded
 * buffer rather than however much the writer felt like producing.
 */
const MAX_STAMP_BYTES = 4096;

export interface AgentSeedStamp {
  readonly schemaVersion: typeof AGENT_SEED_STAMP_VERSION;
  /** The digest-pinned Server image the seed was copied out of. */
  readonly image: string;
  /** `VERITY_SERVER_VERSION` of that image, or the `0.0.0-dev` sentinel. */
  readonly version: string;
  /** When the publisher staged it, or null on a stamp that omitted it. */
  readonly publishedAt: string | null;
}

/**
 * `key=value` lines preserve the bootstrap format shipped before managed
 * publication and keep the provenance file easy to inspect during recovery.
 */
export function parseAgentSeedStamp(text: string): AgentSeedStamp | null {
  if (text.length > MAX_STAMP_BYTES) return null;
  const fields = new Map<string, string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) return null;
    const key = line.slice(0, separator);
    // First wins, so a trailing line cannot silently redefine what was read.
    if (!fields.has(key)) fields.set(key, line.slice(separator + 1));
  }
  const schema = fields.get('schema');
  const image = fields.get('image');
  const version = fields.get('version');
  if (schema !== String(AGENT_SEED_STAMP_VERSION)) return null;
  if (image === undefined || image === '' || version === undefined || version === '') return null;
  const publishedAt = fields.get('published');
  return {
    schemaVersion: AGENT_SEED_STAMP_VERSION,
    image,
    version,
    publishedAt: publishedAt === undefined || publishedAt === '' ? null : publishedAt,
  };
}

/**
 * Reads the stamp out of a seed directory. Every failure — no directory, no
 * stamp, unreadable, malformed — answers null, because the caller's question is
 * "can this seed account for itself", and a stamp that cannot be parsed answers
 * that the same way a missing one does.
 */
export async function readAgentSeedStamp(seedPath: string): Promise<AgentSeedStamp | null> {
  let handle;
  try {
    handle = await open(
      join(seedPath, AGENT_SEED_STAMP_FILE),
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
  } catch {
    return null;
  }
  try {
    // A regular file, or nothing: a fifo or a device where the stamp should be
    // would read as whatever its writer decides, for as long as it decides.
    if (!(await handle.stat()).isFile()) return null;
    // One byte more than the limit, so a file that exceeds it is refused by
    // {@link parseAgentSeedStamp} rather than silently truncated into something
    // that happens to parse.
    const buffer = Buffer.alloc(MAX_STAMP_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseAgentSeedStamp(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** The version a build reports when semantic-release never stamped it. */
export const DEV_VERSION_SENTINEL = '0.0.0-dev';

export type AgentSeedProvenance =
  | { readonly state: 'unknown'; readonly reason: string }
  | { readonly state: 'matched'; readonly stamp: AgentSeedStamp }
  | {
      readonly state: 'skewed';
      readonly stamp: AgentSeedStamp;
      readonly serverVersion: string;
      readonly serverImage: string;
    };

/**
 * Compares a seed stamp against the release the Server itself is.
 *
 * Both version and immutable image digest must agree. A release can be rebuilt
 * without changing its semantic version, so version equality alone is not
 * provenance. Legacy/tag-based stamps remain observable as `unknown` rather
 * than being promoted to a match they cannot prove.
 */
export function compareAgentSeed(
  stamp: AgentSeedStamp | null,
  serverVersion: string,
  serverImage: string | undefined,
): AgentSeedProvenance {
  if (stamp === null)
    return {
      state: 'unknown',
      reason:
        'the agent seed carries no stamp — it was published before Verity stamped it, or by something other than the verity-agent-seed one-shot',
    };
  if (stamp.version === DEV_VERSION_SENTINEL || serverVersion === DEV_VERSION_SENTINEL)
    return {
      state: 'unknown',
      reason: `a development build reports no release version, so the seed (${stamp.version}) and the Server (${serverVersion}) cannot be compared`,
    };
  const seedDigest = /@sha256:([a-f0-9]{64})$/.exec(stamp.image)?.[1];
  const serverDigest =
    serverImage === undefined ? undefined : /@sha256:([a-f0-9]{64})$/.exec(serverImage)?.[1];
  if (seedDigest === undefined || serverDigest === undefined || serverImage === undefined)
    return {
      state: 'unknown',
      reason: 'the agent seed or running Server does not identify an immutable image digest',
    };
  if (stamp.version === serverVersion && seedDigest === serverDigest)
    return { state: 'matched', stamp };
  return { state: 'skewed', stamp, serverVersion, serverImage };
}
