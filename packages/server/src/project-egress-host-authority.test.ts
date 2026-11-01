import { beforeEach, expect, it, vi } from 'vitest';
import {
  egressHostAuthority,
  egressHostDestinationAllowed,
  readEgressHostConfiguration,
} from './project-egress-host-authority.js';
const fs = vi.hoisted(() => ({ open: vi.fn(), lstat: vi.fn(), realpath: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  ...fs,
}));
beforeEach(() => vi.resetAllMocks());
it('requires explicit DNS, canonical direct route inventory and a root-selected sponsor mapping', () => {
  const config = {
    databaseUrl: 'postgres://fixture@localhost/verity',
    dnsServers: ['1.1.1.1'],
    directHosts: ['Downloads.Example.com'],
    projectSponsors: { project: 'sponsor' },
  };
  expect(egressHostAuthority.parse(config).directHosts).toEqual(['downloads.example.com']);
  for (const patch of [
    { dnsServers: [] },
    { databaseUrl: 'file:///secret' },
    { directHosts: ['https://example.com/path'] },
    { unexpected: true },
  ])
    expect(() => egressHostAuthority.parse({ ...config, ...patch })).toThrow();
});
it('refuses foreign ownership, writable ancestors and symlinked configuration and always closes its file', async () => {
  const path = '/etc/verity-egress/authority.json';
  const good = { isFile: () => true, uid: 0, mode: 0o100600, size: 100 };
  const file = {
    stat: vi.fn(async () => good),
    readFile: vi.fn(async () => '{}'),
    close: vi.fn(async () => undefined),
  };
  fs.open.mockResolvedValue(file);
  fs.lstat.mockResolvedValue({
    isDirectory: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    mode: 0o40755,
  });
  fs.realpath.mockResolvedValue(path);
  expect(await readEgressHostConfiguration(path)).toEqual({});
  file.stat.mockResolvedValueOnce({ ...good, uid: 1000 });
  await expect(readEgressHostConfiguration(path)).rejects.toThrow('Untrusted');
  fs.lstat.mockResolvedValueOnce({
    isDirectory: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    mode: 0o40777,
  });
  await expect(readEgressHostConfiguration(path)).rejects.toThrow('directory');
  fs.realpath.mockResolvedValueOnce('/elsewhere/authority.json');
  await expect(readEgressHostConfiguration(path)).rejects.toThrow('Untrusted');
  expect(file.readFile).toHaveBeenCalledOnce();
  expect(file.close).toHaveBeenCalledTimes(4);
});
it('treats only a missing configuration as absent, never permission or parse failure', async () => {
  fs.open.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  expect(await readEgressHostConfiguration('/etc/verity-egress/authority.json')).toBeUndefined();
  fs.open.mockRejectedValueOnce(Object.assign(new Error('permission'), { code: 'EACCES' }));
  await expect(readEgressHostConfiguration('/etc/verity-egress/authority.json')).rejects.toThrow(
    'permission',
  );
});
it('excludes public host addresses and every public project subnet, refreshing inventory on each check', async () => {
  const id = 'a'.repeat(64);
  let subnet = '11.77.1.0/24';
  const io = {
    addresses: vi.fn(async () => JSON.stringify([{ addr_info: [{ local: '8.8.8.8' }] }])),
    docker: vi.fn(async (...args: string[]) =>
      args[1] === 'ls'
        ? id
        : JSON.stringify([
            { IPAM: { Config: [{ Subnet: subnet }, { Subnet: '2001:4860:feed::/64' }] } },
          ]),
    ),
  };
  expect(await egressHostDestinationAllowed('8.8.8.8', io)).toBe(false);
  expect(await egressHostDestinationAllowed('11.77.1.2', io)).toBe(false);
  expect(await egressHostDestinationAllowed('2001:4860:feed::2', io)).toBe(false);
  expect(await egressHostDestinationAllowed('11.77.2.2', io)).toBe(true);
  subnet = '11.77.2.0/24';
  expect(await egressHostDestinationAllowed('11.77.2.2', io)).toBe(false);
  for (const address of ['127.0.0.1', '169.254.169.254', '::ffff:8.8.8.8'])
    expect(await egressHostDestinationAllowed(address, io)).toBe(false);
  io.docker.mockResolvedValueOnce('');
  await expect(egressHostDestinationAllowed('1.1.1.1', io)).rejects.toThrow('inventory');
});
