import { expect, it, vi } from 'vitest';
import { createProtectedAddressInventory } from './project-egress-classification.js';
import {
  createProjectEgressInventoryHistory,
  openProjectEgressInventoryHistory,
} from './project-egress-inventory-history.js';
import { mkdtemp, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('retains retired names and addresses and keeps their DNS refresh coverage', async () => {
  const saves: unknown[] = [];
  const history = createProjectEgressInventoryHistory(
    { version: 1, hosts: [], addresses: [] },
    async (value) => {
      saves.push(value);
    },
  );
  await history.addHosts(['retired.example.org', 'current.example.org']);
  await history.addAddresses(['198.51.100.3', '::ffff:198.51.100.4']);
  await history.addHosts(['current.example.org']);
  await history.addAddresses(['203.0.113.4']);
  expect(history.dnsHosts(['current.example.org'])).toEqual([
    'current.example.org',
    'retired.example.org',
  ]);
  expect(history.hosts()).toContain('retired.example.org');
  expect(history.protectedAddress('198.51.100.3')).toBe(true);
  expect(history.protectedAddress('198.51.100.4')).toBe(true);
  const restored = createProjectEgressInventoryHistory(saves.at(-1), vi.fn());
  expect(restored.hosts()).toContain('retired.example.org');
  expect(restored.protectedAddress('198.51.100.4')).toBe(true);
});

it('does not acknowledge history that failed to persist or exceed its bound', async () => {
  const history = createProjectEgressInventoryHistory(
    { version: 1, hosts: [], addresses: [] },
    async () => {
      throw new Error('disk failed');
    },
  );
  await expect(history.addHosts(['broker.example.org'])).rejects.toThrow('disk failed');
  expect(history.hosts()).toEqual([]);
  await expect(
    history.addAddresses(
      Array.from({ length: 10001 }, (_, i) => `192.0.${Math.floor(i / 256)}.${i % 256}`),
    ),
  ).rejects.toThrow();
  expect(history.protectedAddress('192.0.0.1')).toBe(false);
});

it('persists private history and rejects a substituted symlink on reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'egress-history-'));
  await chmod(directory, 0o700);
  try {
    const history = await openProjectEgressInventoryHistory(directory);
    await history.addHosts(['broker.example.org']);
    const restored = await openProjectEgressInventoryHistory(directory);
    expect(restored.hosts()).toEqual(['broker.example.org']);
    await rm(join(directory, 'system-destinations.json'));
    await symlink('/etc/passwd', join(directory, 'system-destinations.json'));
    await expect(openProjectEgressInventoryHistory(directory)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('excludes a removed endpoint new DNS address after snapshot replacement and restart', async () => {
  let persisted: unknown = { version: 1, hosts: [], addresses: [] };
  let history = createProjectEgressInventoryHistory(persisted, async (value) => {
    persisted = value;
  });
  await history.addHosts(['old-broker.example.org']);
  const addresses = new Map([
    ['old-broker.example.org', '198.51.100.10'],
    ['current.example.org', '203.0.113.20'],
  ]);
  const inventory = (current: string[]) =>
    createProtectedAddressInventory({
      hosts: [],
      configuredHosts: history.dnsHosts(current),
      resolve: async (host) => {
        const address = addresses.get(host);
        if (!address) throw new Error('Missing test DNS');
        await history.addAddresses([address]);
        return { addresses: [address], expiresAt: 1e12 };
      },
    });
  await inventory(['old-broker.example.org']).refresh();
  await history.addHosts(['current.example.org']);
  addresses.set('old-broker.example.org', '198.51.100.11');
  let replacement = inventory(['current.example.org']);
  await replacement.refresh();
  expect(replacement.allows('198.51.100.11')).toBe(false);
  expect(history.protectedAddress('198.51.100.10')).toBe(true);
  expect(history.protectedAddress('198.51.100.11')).toBe(true);
  expect(replacement.allows('192.0.2.30')).toBe(true);
  history = createProjectEgressInventoryHistory(persisted, async (value) => {
    persisted = value;
  });
  addresses.set('old-broker.example.org', '198.51.100.12');
  replacement = inventory(['current.example.org']);
  await replacement.refresh();
  expect(replacement.allows('198.51.100.12')).toBe(false);
  expect(history.protectedAddress('198.51.100.12')).toBe(true);
});
