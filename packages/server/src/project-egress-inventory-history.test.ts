import { expect, it, vi } from 'vitest';
import {
  createProjectEgressInventoryHistory,
  openProjectEgressInventoryHistory,
} from './project-egress-inventory-history.js';
import { mkdtemp, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('retains retired names and addresses across snapshots without DNS-refreshing retired hosts', async () => {
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
  expect(history.dnsHosts(['current.example.org'])).toEqual(['current.example.org']);
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
