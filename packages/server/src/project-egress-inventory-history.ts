import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import ipaddr from 'ipaddr.js';

const historySchema = z.strictObject({
  version: z.literal(1),
  hosts: z
    .array(
      z
        .string()
        .max(253)
        .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u),
    )
    .max(1000),
  addresses: z.array(z.union([z.ipv4(), z.ipv6()])).max(10000),
});
type InventoryHistory = z.infer<typeof historySchema>;

/** Conservative tombstones protect cached clients and in-flight requests after a
 * configuration change or controller restart. Automatic removal would require
 * proof that every old credential-bearing client and connection has retired.
 */
export function createProjectEgressInventoryHistory(
  initial: unknown,
  save: (value: InventoryHistory) => Promise<void>,
) {
  let value = historySchema.parse(initial);
  let tail: Promise<unknown> = Promise.resolve();
  const add = (hosts: readonly string[], addresses: readonly string[]) => {
    const pending = tail.then(async () => {
      const next = historySchema.parse({
        version: 1,
        hosts: [...new Set([...value.hosts, ...hosts])].sort(),
        addresses: [
          ...new Set([
            ...value.addresses,
            ...addresses.map((address) => ipaddr.process(address).toString()),
          ]),
        ].sort(),
      });
      if (JSON.stringify(next) === JSON.stringify(value)) return;
      await save(next);
      value = next;
    });
    tail = pending.catch(() => undefined);
    return pending;
  };
  return {
    addHosts: (hosts: readonly string[]) => add(hosts, []),
    addAddresses: (addresses: readonly string[]) => add([], addresses),
    hosts: () => [...value.hosts],
    dnsHosts: (current: readonly string[]) => {
      if (current.some((host) => !value.hosts.includes(host)))
        throw new Error('Active system host is absent from durable history');
      return [...new Set(current)];
    },
    protectedAddress: (address: string) =>
      value.addresses.includes(ipaddr.process(address).toString()),
  };
}

/** One fixed root-private state file; called only by the host service. */
export async function openProjectEgressInventoryHistory(directory: string) {
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('System inventory history directory is untrusted');
  const path = join(directory, 'system-destinations.json');
  let initial: unknown = { version: 1, hosts: [], addresses: [] };
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (file) {
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.uid !== stat.uid ||
        (info.mode & 0o077) !== 0 ||
        info.size > 1024 * 1024
      )
        throw new Error('System inventory history file is untrusted');
      initial = JSON.parse(await file.readFile('utf8')) as unknown;
    } finally {
      await file.close();
    }
  }
  return createProjectEgressInventoryHistory(initial, async (value) => {
    const temporary = join(directory, `.system-destinations-${randomUUID()}`);
    const output = await open(temporary, 'wx', 0o600);
    try {
      await output.writeFile(JSON.stringify(value));
      await output.sync();
      await output.close();
      await rename(temporary, path);
      const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await output.close();
      await unlink(temporary).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  });
}
