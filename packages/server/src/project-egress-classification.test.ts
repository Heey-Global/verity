import { expect, it } from 'vitest';
import {
  createProtectedAddressInventory,
  mandatoryEgressRoute,
  PROTECTED_ADDRESS_HOSTS,
} from './project-egress-classification.js';
import { EGRESS_DNS_NOT_PUBLIC } from './project-egress-resolver.js';

it('classifies broker and system domains including subdomains, not lookalikes', () => {
  expect(mandatoryEgressRoute('github.com')).toBe('forge');
  expect(mandatoryEgressRoute('API.GitHub.com.')).toBe('forge');
  expect(mandatoryEgressRoute('objects.githubusercontent.com')).toBe('forge');
  expect(mandatoryEgressRoute('www.googleapis.com')).toBe('google');
  expect(mandatoryEgressRoute('api.anthropic.com')).toBe('model');
  expect(mandatoryEgressRoute('chatgpt.com')).toBe('model');
  expect(mandatoryEgressRoute('api.doppler.com')).toBe('secrets');
  expect(mandatoryEgressRoute('mcp.exa.ai')).toBe('search');
  expect(mandatoryEgressRoute('registry.npmjs.org')).toBe('packages');
  expect(mandatoryEgressRoute('repo.maven.apache.org')).toBe('packages');
  for (const host of [
    'evilgithub.com',
    'github.com.evil.net',
    'downloads.example.com',
    'apache.org',
  ])
    expect(mandatoryEgressRoute(host)).toBeUndefined();
  expect(mandatoryEgressRoute('203.0.113.10')).toBeUndefined();
  expect(mandatoryEgressRoute('chat.example.org', ['example.org'])).toBe('configured');
  expect(mandatoryEgressRoute('example.org.evil.net', ['example.org'])).toBeUndefined();
  // Every representative address host is itself classified.
  for (const host of PROTECTED_ADDRESS_HOSTS) expect(mandatoryEgressRoute(host)).toBeDefined();
});

it('denies every address until a complete inventory exists and again once it is stale', async () => {
  let now = 1_000;
  const answers: Record<string, string[]> = {
    'api.github.com': ['140.82.112.6'],
    'registry.npmjs.org': ['104.16.0.34', '2606:4700::6810:22'],
  };
  const inventory = createProtectedAddressInventory({
    hosts: Object.keys(answers),
    now: () => now,
    maxAgeMs: 100,
    resolve: async (host) => ({ addresses: answers[host]!, expiresAt: now + 1_000 }),
  });
  expect(inventory.allows('198.51.100.7')).toBe(false);
  await inventory.refresh();
  expect(inventory.allows('198.51.100.7')).toBe(true);
  for (const address of [
    '140.82.112.6',
    '::ffff:140.82.112.6',
    '104.16.0.34',
    '2606:4700:0:0:0:0:6810:22',
  ])
    expect(inventory.allows(address)).toBe(false);
  now += 101;
  expect(inventory.allows('198.51.100.7')).toBe(false);
});

it("keeps a host's last confirmed addresses through transient failures until they age out", async () => {
  let now = 0;
  let fail = false;
  const inventory = createProtectedAddressInventory({
    hosts: ['api.github.com', 'pypi.org'],
    now: () => now,
    maxAgeMs: 100,
    resolve: async (host) => {
      if (fail && host === 'pypi.org') throw new Error('timeout');
      return {
        addresses: [host === 'pypi.org' ? '151.101.0.223' : '140.82.112.6'],
        expiresAt: 1e9,
      };
    },
  });
  await inventory.refresh();
  fail = true;
  now = 50;
  await expect(inventory.refresh()).rejects.toThrow('inventory incomplete');
  expect(inventory.allows('151.101.0.223')).toBe(false);
  expect(inventory.allows('198.51.100.7')).toBe(true);
  // The failed refresh did not extend the old inventory's age.
  now = 101;
  expect(inventory.allows('198.51.100.7')).toBe(false);
});

it('joins concurrent refreshes instead of overlapping them', async () => {
  const now = 0;
  const releases: (() => void)[] = [];
  let calls = 0;
  const inventory = createProtectedAddressInventory({
    hosts: ['api.github.com'],
    now: () => now,
    maxAgeMs: 1_000,
    resolve: () => {
      calls += 1;
      return new Promise((resolve) =>
        releases.push(() => resolve({ addresses: ['140.82.112.6'], expiresAt: 1e9 })),
      );
    },
  });
  const first = inventory.refresh();
  const second = inventory.refresh();
  expect(second).toBe(first);
  expect(calls).toBe(1);
  releases[0]!();
  await first;
  expect(inventory.allows('140.82.112.6')).toBe(false);
});

it('lets configured hosts add public addresses without invalidating the inventory', async () => {
  const inventory = createProtectedAddressInventory({
    hosts: ['api.github.com'],
    configuredHosts: ['matrix.example.net', 'internal.example.org'],
    resolve: async (host) => {
      if (host === 'internal.example.org') throw new Error('Forbidden project DNS answer');
      return {
        addresses: [host === 'matrix.example.net' ? '198.51.100.20' : '140.82.112.6'],
        expiresAt: 1e12,
      };
    },
  });
  await inventory.refresh();
  expect(inventory.allows('198.51.100.20')).toBe(false);
  expect(inventory.allows('140.82.112.6')).toBe(false);
  expect(inventory.allows('203.0.113.9')).toBe(true);
});

it('treats a definitive non-public answer as no addresses instead of an outage', async () => {
  let now = 0;
  const inventory = createProtectedAddressInventory({
    hosts: ['api.github.com', 'claude.ai', 'retired.example.com'],
    now: () => now,
    maxAgeMs: 100,
    resolve: async (host) => {
      // A sinkholing resolver and a retired name both leave no public front end.
      if (host === 'claude.ai')
        throw Object.assign(new Error('Forbidden project DNS answer'), {
          code: EGRESS_DNS_NOT_PUBLIC,
        });
      if (host === 'retired.example.com')
        throw Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' });
      return { addresses: ['140.82.112.6'], expiresAt: 1e9 };
    },
  });
  await inventory.refresh();
  now = 50;
  expect(inventory.allows('198.51.100.7')).toBe(true);
  expect(inventory.allows('140.82.112.6')).toBe(false);
});

it('keeps configured broker addresses through transient failures and only an oversized answer stays transient', async () => {
  let mode: 'ok' | 'timeout' | 'oversized' | 'gone' = 'ok';
  const inventory = createProtectedAddressInventory({
    hosts: ['api.github.com'],
    configuredHosts: ['matrix.example.net'],
    resolve: async (host) => {
      if (host === 'matrix.example.net' && mode !== 'ok') {
        if (mode === 'gone')
          throw Object.assign(new Error('Invalid project DNS answer count'), {
            code: EGRESS_DNS_NOT_PUBLIC,
          });
        throw new Error(
          mode === 'timeout' ? 'Project DNS deadline exceeded' : 'Invalid project DNS answer count',
        );
      }
      return {
        addresses: [host === 'api.github.com' ? '140.82.112.6' : '198.51.100.20'],
        expiresAt: 1e12,
      };
    },
  });
  await inventory.refresh();
  for (const next of ['timeout', 'oversized'] as const) {
    mode = next;
    await inventory.refresh();
    expect(inventory.allows('198.51.100.20')).toBe(false);
  }
  mode = 'gone';
  await inventory.refresh();
  expect(inventory.allows('198.51.100.20')).toBe(true);
});
