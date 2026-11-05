import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { ProjectEgressHealthError } from './project-egress-health.js';
import type { ProjectEgressHostRequest, ProjectEgressHostResponse } from './project-egress-host.js';

/** Endpoint metadata only. Never serialize paths, credentials or query strings. */
export function projectEgressSystemDestinations(urls: readonly string[]): {
  hosts: string[];
  addresses: string[];
} {
  if (urls.length > 1000) throw new Error('System destination inventory exceeds its bound');
  const hosts = new Set<string>();
  const addresses = new Set<string>();
  for (const input of urls) {
    const url = new URL(input);
    const host = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/gu, '')
      .replace(/\.$/u, '');
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('System destination cannot be represented by the host inventory');
    if (host === 'localhost') {
      addresses.add('127.0.0.1');
      addresses.add('::1');
      continue;
    }
    if (isIP(host) !== 0) {
      addresses.add(host);
      continue;
    }
    if (
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(host)
    )
      throw new Error('System destination cannot be represented by the host inventory');
    hosts.add(host);
  }
  if (hosts.size > 100 || addresses.size > 100)
    throw new Error('System host inventory exceeds its bound');
  return { hosts: [...hosts].sort(), addresses: [...addresses].sort() };
}

export function projectEgressSystemInventoryHash(
  hosts: readonly string[],
  addresses: readonly string[] = [],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        hosts: [...new Set(hosts)].sort(),
        addresses: [...new Set(addresses)].sort(),
      }),
    )
    .digest('hex');
}

/** In-memory lease: controller restart never inherits a previously complete snapshot.
 * A begin token is an exclusive mutation lease across active and standby Servers.
 */
export function createManagedSystemInventory(options: {
  managed: boolean;
  replace(hosts: readonly string[], addresses: readonly string[]): Promise<void>;
  invalidate(): void;
  now?: () => number;
  healthy?: () => boolean;
}) {
  const now = options.now ?? Date.now;
  let readyUntil = 0;
  let snapshotHash: string | undefined;
  let owner: { token: string; until: number } | undefined;
  return {
    invalidate() {
      readyUntil = 0;
      options.invalidate();
    },
    begin(token: string) {
      readyUntil = 0;
      options.invalidate();
      if (!options.managed) throw new Error('Managed inventory is not configured');
      if (owner && now() <= owner.until) throw new Error('System inventory mutation is busy');
      owner = { token, until: now() + 30_000 };
    },
    async commit(token: string, hosts: readonly string[], addresses: readonly string[] = []) {
      if (!owner || owner.token !== token || now() > owner.until)
        throw new Error('System inventory mutation lease expired');
      await options.replace(hosts, addresses);
      if (now() > owner.until) throw new Error('System inventory mutation lease expired');
      snapshotHash = projectEgressSystemInventoryHash(hosts, addresses);
      readyUntil = now() + 30_000;
      owner = undefined;
    },
    renew(hash: string) {
      if (
        owner ||
        readyUntil <= now() + 5_000 ||
        snapshotHash !== hash ||
        options.healthy?.() === false
      )
        throw new Error('System inventory snapshot requires synchronization');
      readyUntil = now() + 30_000;
    },
    ready() {
      // Direct packet grants live at most five seconds. Stop renewing them before
      // the inventory lease ends, so their kernel deadlines cannot outlive it.
      return (!options.managed || readyUntil > now() + 5_000) && options.healthy?.() !== false;
    },
    verify() {
      if ((options.managed && readyUntil <= now() + 5_000) || options.healthy?.() === false)
        throw new ProjectEgressHealthError('mandatory_inventory_incomplete');
    },
  };
}

/** Fence before persistence, synchronize the committed snapshot before acknowledging
 * a write. The single host mutation lease also serializes writers from other Servers.
 */
export function createProjectEgressInventorySynchronizer(options: {
  command(input: ProjectEgressHostRequest): Promise<ProjectEgressHostResponse>;
  enabled?(): boolean;
  readUrls(): Promise<readonly string[]>;
  transaction<T>(action: () => Promise<T>): Promise<T>;
}) {
  let tail: Promise<unknown> = Promise.resolve();
  let sourceRepairRequiresRestart = false;
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const pending = tail.then(action);
    tail = pending.catch(() => undefined);
    return pending;
  };
  const sync = <T>(action: () => Promise<T>): Promise<T> =>
    options.transaction(async () => {
      const previous = await options.readUrls();
      const token = randomUUID();
      const begin = await options.command({ operation: 'inventory-begin', token });
      if (begin.state !== 'inventory-denied' || begin.token !== token)
        throw new Error('System inventory fencing was not acknowledged');
      // A failed source write rolls back its SQL transaction and leaves the host
      // fenced until a fresh synchronization; it must not publish completeness.
      const result = await action();
      // Until the SQL commit, other readers still use the prior endpoints.
      // Protect both snapshots before making the new configuration visible.
      let snapshot: ReturnType<typeof projectEgressSystemDestinations> | undefined;
      try {
        snapshot = projectEgressSystemDestinations([...previous, ...(await options.readUrls())]);
      } catch {
        // Persist a repair under verified denial, but do not declare completeness
        // while this process can retain clients for an unrepresentable old URL.
        sourceRepairRequiresRestart = true;
      }
      if (snapshot && !sourceRepairRequiresRestart) {
        const committed = await options.command({
          operation: 'inventory-commit',
          token,
          ...snapshot,
        });
        if (committed.state !== 'inventory-ready' || committed.token !== token)
          throw new Error('System inventory synchronization was not acknowledged');
      }
      return result;
    });
  return {
    mutate: <T>(action: () => Promise<T>) =>
      serialize(() => (options.enabled?.() === false ? action() : sync(action))),
    refresh: () =>
      serialize(() => {
        if (options.enabled?.() === false) return Promise.resolve();
        return options.transaction(async () => {
          const token = randomUUID();
          if (sourceRepairRequiresRestart)
            throw new ProjectEgressHealthError('mandatory_inventory_incomplete');
          const snapshot = projectEgressSystemDestinations(await options.readUrls());
          const hash = projectEgressSystemInventoryHash(snapshot.hosts, snapshot.addresses);
          try {
            const result = await options.command({ operation: 'inventory-renew', token, hash });
            if (result.state !== 'inventory-ready' || result.token !== token)
              throw new Error('System inventory renewal was not acknowledged');
          } catch {
            // A restart or changed snapshot needs actual fencing; an unchanged healthy
            // heartbeat must never tear down long-lived direct connections.
            await sync(() => Promise.resolve());
          }
        });
      }),
  };
}
