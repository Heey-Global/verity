import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { generateBackupKeys } from './crypto.js';
import { BackupDestination } from './destination.js';
import { requestBackupIdentity } from './identity-request.js';
import { writeBackupIdentityFixture } from './testing.js';

it('rejects a previous recipient receipt, publishes only public input and aborts waiting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-request-'));
  let destination: BackupDestination | undefined;
  try {
    const installationId = randomUUID();
    const { host } = await generateBackupKeys();
    await writeBackupIdentityFixture(root, host, installationId);
    const target = join(root, 'target');
    const requests = join(root, 'requests');
    await mkdir(join(target, 'identity'), { recursive: true });
    await mkdir(requests);
    const targetId = randomUUID();
    await writeFile(join(target, '.verity-backup-target'), targetId);
    destination = await BackupDestination.open(target, targetId);
    const receiptPath = join(target, 'identity', `${installationId}-ca-key-k1`);
    await writeFile(receiptPath, await readFile(join(root, 'ca.age')));
    const options = {
      requestRoot: requests,
      destination,
      installationId,
      keyGeneration: 1,
      recipient: host.recipient,
      certificate: await readFile(join(root, 'identity/tls-ca-cert.pem')),
      signal: AbortSignal.timeout(5000),
    };
    expect(await requestBackupIdentity(options)).toContain(`${installationId}-ca-key-k1`);
    const { host: other } = await generateBackupKeys();
    await expect(
      requestBackupIdentity({
        ...options,
        recipient: other.recipient,
        signal: AbortSignal.timeout(150),
      }),
    ).rejects.toThrow();
    expect(JSON.parse(await readFile(join(requests, 'recipient.json'), 'utf8'))).toEqual({
      recipient: other.recipient,
      keyGeneration: 1,
    });
    // A cancelled wait releases the process lock for a subsequent valid request.
    await expect(requestBackupIdentity(options)).resolves.toContain(`${installationId}-ca-key-k1`);
  } finally {
    await destination?.close();
    await rm(root, { recursive: true, force: true });
  }
});
