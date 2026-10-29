import pg from 'pg';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDatabaseUrl, readBackupCapabilities } from './prerequisites.js';
import { encryptCaForRecipient } from './identity-helper-cli.js';
import { decryptStream, generateBackupKeys } from './crypto.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('backup installer capability', () => {
  it('detects actual prerequisites and keeps credentials out of the public result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-backup-prereq-'));
    roots.push(root);
    const paths = {
      pairing: join(root, 'pairing'),
      destination: join(root, 'destination'),
      identityRequests: join(root, 'requests'),
    };
    expect((await readBackupCapabilities(paths)).available).toBe(false);
    for (const directory of Object.values(paths)) await mkdir(directory);
    const id = '11111111-1111-4111-8111-111111111111';
    await writeFile(join(paths.pairing, 'installation-id'), id);
    await writeFile(join(paths.destination, '.verity-backup-target'), id);
    await writeFile(join(paths.pairing, 'backup-postgres-password'), 'a'.repeat(64));
    const capability = await readBackupCapabilities(paths);
    expect(capability).toEqual({ available: true, installationId: id, targetId: id });
    expect(JSON.stringify(capability)).not.toContain('a'.repeat(64));
    const url = new URL(
      await backupDatabaseUrl(
        'postgres://admin:old@postgres/verity?sslmode=verify-full&options=unsafe&user=admin&password=query-secret',
        paths.pairing,
      ),
    );
    expect(url.username).toBe('verity_backup');
    expect(url.password).toBe('a'.repeat(64));
    expect(url.searchParams.get('sslmode')).toBe('verify-full');
    expect(url.searchParams.has('options')).toBe(false);
    const client = new pg.Client({ connectionString: url.toString() });
    expect(client.user).toBe('verity_backup');
    expect(client.password).toBe('a'.repeat(64));
    await rm(join(paths.destination, '.verity-backup-target'));
    await symlink(
      join(paths.pairing, 'installation-id'),
      join(paths.destination, '.verity-backup-target'),
    );
    expect((await readBackupCapabilities(paths)).available).toBe(false);
  });
  it('encrypts helper CA input to the confirmed recipient and rejects malformed requests', async () => {
    const { host, recoveryKey } = await generateBackupKeys();
    const original = Buffer.from('test CA key material');
    const source = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(original);
          c.close();
        },
      });
    const encrypted = await encryptCaForRecipient(host.recipient, source());
    const recovered = Buffer.from(
      await new Response(await decryptStream(recoveryKey, encrypted)).arrayBuffer(),
    );
    expect(recovered.equals(original)).toBe(true);
    await expect(encryptCaForRecipient('../path', source())).rejects.toThrow();
  });
});
