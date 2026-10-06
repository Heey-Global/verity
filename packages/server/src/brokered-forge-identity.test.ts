import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadForgeProxyIdentity } from './brokered-forge-identity.js';

describe('forge proxy identity', () => {
  it('retains the sandbox trust anchor across restarts and keeps private material in a restricted directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-forge-identity-'));
    try {
      const first = await loadForgeProxyIdentity(root);
      const second = await loadForgeProxyIdentity(root);
      expect(second.ca.caCertPem).toBe(first.ca.caCertPem);
      expect(second.ca.caKeyPem).toBe(first.ca.caKeyPem);
      expect((await stat(join(root, 'forge-proxy'))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, 'forge-proxy', 'ca.key'))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(root, 'forge-proxy', 'ca.key'), 'utf8')).toBe(first.ca.caKeyPem);
      await rm(join(root, 'forge-proxy', 'ca.crt'));
      await expect(loadForgeProxyIdentity(root)).rejects.toThrow('incomplete forge proxy identity');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('refuses invalid existing credentials rather than changing the trusted identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-forge-identity-'));
    try {
      await loadForgeProxyIdentity(root);
      await writeFile(join(root, 'forge-proxy', 'ca.key'), 'invalid-private-key');
      await expect(loadForgeProxyIdentity(root)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
