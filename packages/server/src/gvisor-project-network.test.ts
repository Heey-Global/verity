import { describe, expect, it, vi } from 'vitest';

import {
  parseSandboxDnsServers,
  relayHostEntries,
  relayResolverAddress,
  sandboxResolvConf,
} from './gvisor-project-network.js';

// A gVisor Sandbox cannot reach Docker's embedded resolver, so a relay name that is not pinned
// resolves to nothing, and the turn only fails later, at egress, with ENOTFOUND. These cover what
// the pinning is built from — what Docker reports for the relay — and the resolver the Sandbox
// is pointed at instead of 127.0.0.11: that same relay.

describe('relayHostEntries', () => {
  const network = 'verity-proj-p1';

  it('pins each distinct relay hostname to its address on the project network', async () => {
    const inspectContainer = vi.fn(async (name: string) => ({
      id: name,
      running: true,
      networks: {
        bridge: { ipAddress: '172.17.0.9' },
        [network]: { ipAddress: '172.30.0.2' },
      },
    }));
    await expect(
      relayHostEntries({ inspectContainer }, network, [
        'http://verity-relay-p1-g1:8080',
        'https://verity-relay-p1-g1:8443',
        'https://verity-relay-p1-g1:8444',
        undefined,
      ]),
    ).resolves.toEqual(['verity-relay-p1-g1:172.30.0.2']);
    expect(inspectContainer).toHaveBeenCalledOnce();
  });

  it('leaves literal addresses alone', async () => {
    const inspectContainer = vi.fn();
    await expect(
      relayHostEntries({ inspectContainer }, network, ['https://10.0.0.5:8443']),
    ).resolves.toEqual([]);
    expect(inspectContainer).not.toHaveBeenCalled();
  });

  it('fails when the relay is not on the project network rather than pinning nothing', async () => {
    const inspectContainer = vi.fn(async (name: string) => ({
      id: name,
      running: true,
      networks: { bridge: { ipAddress: '172.17.0.9' } },
    }));
    await expect(
      relayHostEntries({ inspectContainer }, network, ['http://verity-relay-p1-g1:8080']),
    ).rejects.toThrow(`verity-relay-p1-g1 has no address on ${network}`);
  });
});

describe('the Sandbox resolver', () => {
  // v1.5.2 read upstream servers out of Docker's resolv.conf. On a systemd-resolved host Docker
  // names only 127.0.0.53 there, so every gVisor Sandbox on stock Ubuntu resolved nothing.
  it('is the relay, at the address pinned for it', () => {
    expect(
      relayResolverAddress('https://verity-relay-p1-g1:8443', ['verity-relay-p1-g1:172.30.0.2']),
    ).toBe('172.30.0.2');
  });

  it('is a relay addressed by IP as it is', () => {
    expect(relayResolverAddress('https://10.0.0.5:8443', [])).toBe('10.0.0.5');
  });

  it('refuses to guess when the relay has no pinned address', () => {
    expect(() =>
      relayResolverAddress('https://verity-relay-p1-g1:8443', ['other:172.30.0.9']),
    ).toThrow('verity-relay-p1-g1 has no pinned address');
  });

  it('validates operator-configured resolvers', () => {
    expect(parseSandboxDnsServers(' 192.0.2.53, 2001:db8::53 ,')).toEqual([
      '192.0.2.53',
      '2001:db8::53',
    ]);
    expect(() => parseSandboxDnsServers('dns.example')).toThrow('not a non-loopback IP');
    expect(() => parseSandboxDnsServers('127.0.0.11')).toThrow('not a non-loopback IP');
  });

  it('writes a resolv.conf with only the given servers', () => {
    expect(sandboxResolvConf(['192.0.2.53', '192.0.2.54'])).toBe(
      'nameserver 192.0.2.53\nnameserver 192.0.2.54\noptions ndots:0\n',
    );
  });
});
