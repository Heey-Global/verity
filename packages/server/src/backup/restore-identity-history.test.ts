import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { assertRestorableIdentity } from './restore-identity-history.js';
import { writeBackupIdentityFixture } from './testing.js';
import { generateBackupKeys } from './crypto.js';

it('fences retired snapshot identities, missing/corrupt history and symlinks while allowing explicit new identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retired-identity-'));
  try {
    const { host } = await generateBackupKeys();
    await writeBackupIdentityFixture(root, host, randomUUID());
    const ledger = join(root, 'retired-identity-ca-sha256');
    await assertRestorableIdentity(root, root, false);
    await mkdir(join(root, 'identity-rotation'));
    await expect(assertRestorableIdentity(root, root, false)).rejects.toThrow('history is missing');
    const ca = new X509Certificate(await readFile(join(root, 'identity/tls-ca-cert.pem')));
    const hash = createHash('sha256').update(ca.raw).digest('hex');
    await writeFile(ledger, hash + '\n', { mode: 0o600 });
    await expect(assertRestorableIdentity(root, root, false)).rejects.toThrow(
      'identity was retired',
    );
    await assertRestorableIdentity(root, root, true);
    await writeFile(ledger, 'a'.repeat(64) + '\n');
    await assertRestorableIdentity(root, root, false);
    await writeFile(ledger, 'corrupt');
    await expect(assertRestorableIdentity(root, root, false)).rejects.toThrow(
      'Invalid identity rotation history',
    );
    await assertRestorableIdentity(root, root, true);
    await chmod(ledger, 0o666);
    await expect(assertRestorableIdentity(root, root, false)).rejects.toThrow(
      'Unsafe identity rotation history',
    );
    await rm(ledger);
    await symlink(join(root, 'identity/tls-ca-cert.pem'), ledger);
    await expect(assertRestorableIdentity(root, root, false)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
