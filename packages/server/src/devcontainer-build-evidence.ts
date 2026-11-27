import { createHmac, randomBytes } from 'node:crypto';
import { closeSync, lstatSync, openSync, readdirSync, readlinkSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';

import type { BuildStorage } from './build-storage.js';

import {
  createDevcontainerBuildSnapshot,
  type DevcontainerBuildSnapshot,
} from './devcontainer-build-boundary.js';

export interface DevcontainerBuildEvidence {
  /** Opaque identifier for this attempt's actual snapshot, including uncommitted bytes.
   * The random per-attempt key is never persisted; identifiers cannot be compared
   * across attempts or used to guess secret-bearing build inputs. */
  readonly fingerprint: string;
  assertSourceUnchanged(workspaceFolder: string, temporaryRoot?: string): Promise<void>;
}

/** Only traverse a private, validated build snapshot, never the mutable source tree.
 * Frame every item to distinguish path/type/mode/content boundaries. */
async function fingerprint(snapshot: DevcontainerBuildSnapshot, key: Buffer): Promise<string> {
  const mac = createHmac('sha256', key).update('verity.devcontainer-build-snapshot.v1\0');
  const frame = (value: string): void => {
    mac.update(`${Buffer.byteLength(value)}:`).update(value);
  };
  let bytesSinceYield = 0;
  let entriesSinceYield = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const name of readdirSync(directory).sort()) {
      if (++entriesSinceYield >= 64) {
        await setImmediate();
        entriesSinceYield = 0;
      }
      const path = join(directory, name);
      const relative = `${prefix}${name}`;
      const stat = lstatSync(path);
      frame(relative);
      if (stat.isSymbolicLink()) {
        frame('link');
        frame(readlinkSync(path));
      } else if (stat.isDirectory()) {
        frame('directory');
        frame(String(stat.mode & 0o777));
        await visit(path, `${relative}/`);
      } else if (stat.isFile()) {
        frame('file');
        frame(String(stat.mode & 0o777));
        frame(String(stat.size));
        const fd = openSync(path, 'r');
        try {
          const buffer = Buffer.allocUnsafe(64 * 1024);
          let bytes: number;
          while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) !== 0) {
            mac.update(buffer.subarray(0, bytes));
            bytesSinceYield += bytes;
            if (bytesSinceYield >= 1024 * 1024) {
              await setImmediate();
              bytesSinceYield = 0;
            }
          }
        } finally {
          closeSync(fd);
        }
      } else {
        throw new Error('Invalid devcontainer build snapshot entry');
      }
    }
  };
  await visit(snapshot.workspaceFolder, '');
  return mac.digest('hex');
}

/** Capture before server-injected configuration changes (such as base-image pinning).
 * The source check repeats the existing admission and normalization rules, so ignored
 * worktrees and unrelated untracked files cannot turn into false consistency failures. */
export async function captureDevcontainerBuildEvidence(
  snapshot: DevcontainerBuildSnapshot,
): Promise<DevcontainerBuildEvidence> {
  const key = randomBytes(32);
  const expected = await fingerprint(snapshot, key);
  return {
    fingerprint: expected,
    async assertSourceUnchanged(workspaceFolder, temporaryRoot) {
      const current = await createDevcontainerBuildSnapshot(workspaceFolder, temporaryRoot);
      try {
        if ((await fingerprint(current, key)) !== expected) {
          throw new Error(
            'devcontainer build inputs changed before setup; rebuild the image from the current workspace',
          );
        }
      } finally {
        await current.dispose();
      }
    },
  };
}

/** Reuse build-storage admission for the comparison copy, releasing the slot even
 * when input validation, copying or equality fails. No builder runs for this check. */
export function buildSourceCheck(
  evidence: DevcontainerBuildEvidence,
  source: string,
  storage?: Pick<BuildStorage, 'admitInTurn'>,
  owner?: { label: string; projectId?: string },
): () => Promise<void> {
  return async () => {
    const lease = await storage?.admitInTurn(undefined, owner);
    try {
      await evidence.assertSourceUnchanged(source, lease?.directory);
    } finally {
      lease?.dispose();
    }
  };
}

/** Commit is supplemental provenance; it does not identify dirty snapshot inputs. */
export async function checkoutBuildCommit(
  git: (args: string[]) => Promise<{ stdout: string }>,
  clonePath: string,
): Promise<string | null> {
  try {
    const head = (await git(['-C', clonePath, 'rev-parse', '--verify', 'HEAD'])).stdout.trim();
    return /^[0-9a-f]{7,64}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}
