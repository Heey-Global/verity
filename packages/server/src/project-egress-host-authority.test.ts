import { beforeEach, expect, it, vi } from 'vitest';
import {
  egressHostAuthority,
  egressBuildProtectedNetworks,
  egressHostDestinationAllowed,
  egressHostDirectChecks,
  readEgressHostConfiguration,
  verifyEgressHostAuthorityReady,
} from './project-egress-host-authority.js';
const fs = vi.hoisted(() => ({ open: vi.fn(), lstat: vi.fn(), realpath: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  ...fs,
}));
beforeEach(() => vi.resetAllMocks());
it('requires explicit DNS and a database, with no host inventory or sponsor list', () => {
  const config = {
    databaseUrl: 'postgres://fixture@localhost/verity',
    dnsServers: ['1.1.1.1'],
  };
  expect(egressHostAuthority.parse(config).mandatoryHosts).toEqual([]);
  expect(() => egressHostAuthority.parse({ ...config, mandatoryHosts: ['198.51.100.20'] })).toThrow(
    /names, not addresses/,
  );
  expect(
    egressHostAuthority.parse({ ...config, mandatoryHosts: ['Matrix.Example.net'] }).mandatoryHosts,
  ).toEqual(['matrix.example.net']);
  for (const patch of [
    { dnsServers: [] },
    { databaseUrl: 'file:///secret' },
    { directHosts: ['downloads.example.com'] },
    { projectSponsors: { project: 'sponsor' } },
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

it('admits any non-broker host at unprotected, allowed addresses', async () => {
  const authority = {
    databaseUrl: 'postgres://fixture@localhost/verity',
    dnsServers: ['1.1.1.1'],
    mandatoryHosts: ['chat.example.net'],
  };
  const allowed = vi.fn(async (address: string) => address !== '10.0.0.1');
  const checks = egressHostDirectChecks(
    authority,
    { allows: (address) => address !== '140.82.112.6' },
    allowed,
  );
  expect(await checks.directTargetAllowed('downloads.example.com')).toBe(true);
  expect(await checks.directTargetAllowed('chat.example.net')).toBe(false);
  expect(await checks.directTargetAllowed('api.github.com')).toBe(false);
  expect(await checks.directTargetAllowed('other.example.com')).toBe(true);
  // Project grants never reach exa.ai; only the host-owned system grant does.
  expect(await checks.directTargetAllowed('mcp.exa.ai')).toBe(false);
  expect(await checks.destinationAllowed('198.51.100.7')).toBe(true);
  expect(await checks.destinationAllowed('140.82.112.6')).toBe(false);
  expect(await checks.destinationAllowed('10.0.0.1')).toBe(false);
  const absent = egressHostDirectChecks(undefined, { allows: () => true }, allowed);
  expect(await absent.directTargetAllowed('downloads.example.com')).toBe(false);
});

it('denies all direct grants and readiness until the managed mandatory inventory is complete', async () => {
  const config = egressHostAuthority.parse({
    databaseUrl: 'postgres://fixture@localhost/verity',
    dnsServers: ['1.1.1.1'],
    managedInventoryComplete: false,
  });
  const checks = egressHostDirectChecks(config, { allows: () => true }, async () => true);
  expect(await checks.directTargetAllowed('unclassified-private-broker.example.net')).toBe(false);
  expect(() => verifyEgressHostAuthorityReady(config)).toThrow();
  expect(() => verifyEgressHostAuthorityReady(undefined)).toThrow();
  // Explicit fixture configurations remain compatible; the managed producer sets false.
  expect(() =>
    verifyEgressHostAuthorityReady({ ...config, managedInventoryComplete: undefined }),
  ).not.toThrow();
});

it('collects complete host-connected and Docker exclusions for public build access', async () => {
  const id = 'a'.repeat(64);
  const io = {
    routes: async () => JSON.stringify([{ dst: 'default', dev: 'eth0' }]),
    addresses: async () =>
      JSON.stringify([
        {
          addr_info: [
            { local: '8.9.10.11', prefixlen: 24 },
            { local: '2606:4700::12', prefixlen: 64 },
          ],
        },
      ]),
    docker: vi.fn(async (...args: string[]) =>
      args[1] === 'ls'
        ? id
        : JSON.stringify([
            {
              Id: id,
              IPAM: { Config: [{ Subnet: '9.10.11.0/24' }, { Subnet: '2606:4701::/64' }] },
            },
          ]),
    ),
  };
  expect(await egressBuildProtectedNetworks(io)).toEqual({
    blocked: ['8.9.10.11/24', '2606:4700::12/64', '9.10.11.0/24', '2606:4701::/64'],
    uplinks: ['eth0'],
  });
  io.docker.mockResolvedValueOnce(id).mockResolvedValueOnce('[]');
  await expect(egressBuildProtectedNetworks(io)).rejects.toThrow('Incomplete');
  io.docker.mockResolvedValueOnce('');
  await expect(egressBuildProtectedNetworks(io)).rejects.toThrow('Invalid');
});
