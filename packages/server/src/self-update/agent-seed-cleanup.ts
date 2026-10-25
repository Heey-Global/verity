import { lstat, readdir, readlink, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { DockerClient } from '../docker.js';
import { readAgentSeedStamp } from './agent-seed-stamp.js';
import { agentSeedPublicationKey } from './managed-companion-reconcile.js';
import { withAgentSeedLease } from './agent-seed-lease.js';

const KEY = /^[a-f0-9]{64}$/;
const selection = async (root: string, name: string): Promise<string> => {
  const link = await readlink(join(root, name));
  if (!/^\.versions\/[a-f0-9]{64}$/.test(link)) throw new Error('unrecognized seed selection');
  return link.slice('.versions/'.length);
};

export interface AgentSeedCleanupResult {
  deleted: string[];
  skipped?: string;
}

/** Only reclaim releases whose lack of references can be established completely. */
export async function cleanupAgentSeedVersions(options: {
  root: string;
  hostRoot: string;
  docker: Pick<DockerClient, 'listContainers' | 'inspectContainer'>;
}): Promise<AgentSeedCleanupResult> {
  const deleted: string[] = [];
  try {
    return await withAgentSeedLease(options.root, async () => {
      if (!isAbsolute(options.hostRoot)) throw new Error('seed host root is not absolute');
      const current = await selection(options.root, '.current');
      const previous = await selection(options.root, '.previous');
      const protectedKeys = new Set([current, previous]);
      const versions = join(options.root, '.versions');
      if (!(await lstat(versions)).isDirectory())
        throw new Error('seed versions is not a directory');
      const entries = await readdir(versions, { withFileTypes: true });
      const candidates: string[] = [];
      for (const entry of entries) {
        // Staging trees and foreign files are never garbage-collection targets.
        if (!KEY.test(entry.name)) continue;
        if (!entry.isDirectory()) throw new Error('seed release is not a directory');
        const stamp = await readAgentSeedStamp(join(versions, entry.name));
        if (stamp === null || agentSeedPublicationKey(stamp.image, stamp.version) !== entry.name)
          throw new Error('seed release provenance is incomplete');
        candidates.push(entry.name);
      }
      if (!candidates.includes(current) || !candidates.includes(previous))
        throw new Error('seed selection is missing');
      const list = options.docker.listContainers;
      if (list === undefined) throw new Error('container inventory is unavailable');
      const containers = await list();
      for (const container of containers) {
        const state = await options.docker.inspectContainer(container.id);
        if (state.mounts === undefined || state.mountCount !== state.mounts.length)
          throw new Error('container mount inventory is incomplete');
        const lifecycleOwner =
          ['updater', 'companion-handoff', 'agent-seed-cleanup'].includes(
            state.labels?.['verity.managed-role'] ?? '',
          ) ||
          ['verity-updater', 'verity-agent-seed'].includes(
            state.labels?.['com.docker.compose.service'] ?? '',
          );
        for (const mount of state.mounts) {
          if (
            mount.type === undefined ||
            mount.source === undefined ||
            mount.destination === undefined
          )
            throw new Error('container mount metadata is incomplete');
          if (mount.type !== 'bind') continue;
          if (!isAbsolute(mount.source)) throw new Error('container bind source is not absolute');
          const subpath = relative(resolve(options.hostRoot), resolve(mount.source));
          if (subpath === '.current' || subpath.startsWith('.current/'))
            throw new Error('a container still uses an ambiguous .current seed mount');
          if (subpath.startsWith('.versions/')) {
            const key = subpath.split('/')[1]!;
            if (!KEY.test(key) || !candidates.includes(key))
              throw new Error('container references an unknown seed release');
            protectedKeys.add(key);
          }
          // A root or ancestor mount can reach any historical release. Only the
          // lifecycle owners publish under the lease rather than use old bytes.
          const ancestor = relative(resolve(mount.source), resolve(options.hostRoot));
          if (
            (subpath === '' || (!ancestor.startsWith('..') && !isAbsolute(ancestor))) &&
            !lifecycleOwner
          )
            throw new Error('a container still uses an ambiguous legacy seed mount');
          if (
            subpath !== '' &&
            !subpath.startsWith('..') &&
            !isAbsolute(subpath) &&
            !subpath.startsWith('.versions/')
          )
            throw new Error('a container uses an unrecognized seed alias');
          if (
            mount.destination === '/opt/agent-seed' &&
            subpath !== '' &&
            (subpath.startsWith('..') || isAbsolute(subpath))
          )
            throw new Error('a seed mount uses an unrecognized host root');
        }
        // A Server can be configured to create future containers from a pinned tree.
        for (const value of state.env ?? []) {
          if (!/^VERITY_AGENT_SEED_(?:HOST_PATH|ROOT_HOST_PATH)=/.test(value)) continue;
          const configured = value.slice(value.indexOf('=') + 1);
          const subpath = relative(resolve(options.hostRoot), resolve(configured));
          if (subpath.startsWith('.versions/')) protectedKeys.add(subpath.split('/')[1]!);
        }
      }
      // Creation/removal during discovery makes the snapshot insufficient. New
      // managed creates select .current, which is protected under the same lease
      // as publication; old explicit references were collected above.
      const again = await list();
      if (
        containers
          .map((item) => item.id)
          .sort()
          .join('\0') !==
        again
          .map((item) => item.id)
          .sort()
          .join('\0')
      )
        throw new Error('container inventory changed during seed cleanup');
      for (const key of candidates) {
        if (protectedKeys.has(key)) continue;
        await rm(join(versions, key), { recursive: true });
        deleted.push(key);
      }
      return { deleted };
    });
  } catch (error) {
    return { deleted, skipped: error instanceof Error ? error.message : 'seed cleanup failed' };
  }
}
