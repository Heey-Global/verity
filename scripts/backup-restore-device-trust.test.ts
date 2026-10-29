import { createServer } from 'node:https';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  certificatePin,
  pinnedApi,
  verifyPairingProof,
} from '../.github/scripts/backup-restore-device-trust.mjs';
import { writeBackupIdentityFixture } from '../packages/server/src/backup/testing.js';
import { generateBackupKeys } from '../packages/server/src/backup/crypto.js';
import { createDevicePairingManager } from '../packages/server/src/device-pairing.js';
import { createRestoreHost } from '../packages/server/src/backup/restore-host.js';
import { mkdir, writeFile } from 'node:fs/promises';
import type { RestoreJob } from '../packages/server/src/backup/restore-job.js';

it('checks saved leaf pins and fresh pairing proofs over TLS and rejects mismatched trust before the HTTP handler', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-device-tls-'));
  let close: (() => Promise<void>) | undefined;
  try {
    const { host } = await generateBackupKeys();
    await writeBackupIdentityFixture(root, host, randomUUID());
    const id = randomUUID();
    const job = {
      id,
      installationId: randomUUID(),
      selection: { newIdentity: false },
      verified: { deploymentId: 'deployment-fixture', image: 'fixture@sha256:' + 'a'.repeat(64) },
    } as RestoreJob;
    await mkdir(join(root, id));
    await writeFile(
      join(root, id, 'database'),
      JSON.stringify({ jobId: id, password: 'a'.repeat(64) }),
    );
    await createRestoreHost({
      root,
      addresses: [],
      serverUid: process.getuid?.() ?? 1000,
      serverGid: process.getgid?.() ?? 1000,
    })(job, root, await readFile(join(root, 'ca.pem')));
    const staged = join(root, id, 'host');
    const pairing = createDevicePairingManager({
      privateKeyPem: await readFile(join(staged, 'pairing-identity.pem'), 'utf8'),
      pairingCode: 'a'.repeat(32),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      loadConsumedCodeHash: () => undefined,
      storeConsumedCodeHash: () => true,
    });
    let requests = 0;
    let advertisedIdentity = pairing.identity();
    const server = createServer(
      {
        key: await readFile(join(staged, 'tls-key.pem')),
        cert: await readFile(join(staged, 'tls-cert.pem')),
      },
      (req, res) => {
        requests++;
        const challenge = new URL(req.url!, 'https://localhost').searchParams.get('challenge')!;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ...advertisedIdentity, ...pairing.signChallenge(challenge) }));
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    close = () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No listener');
    const options = {
      address: '127.0.0.1',
      port: address.port,
      ca: await readFile(join(staged, 'tls-ca-cert.pem')),
      pin: certificatePin(await readFile(join(root, 'identity/tls-cert.pem'))),
    };
    await verifyPairingProof(pinnedApi(options), pairing.identity());
    expect(requests).toBe(1);
    await expect(
      verifyPairingProof(
        pinnedApi({ ...options, pin: 'sha256-' + 'a'.repeat(43) }),
        pairing.identity(),
      ),
    ).rejects.toThrow('TLS pin mismatch');
    expect(requests).toBe(1);
    const wrongKey = generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'der' })
      .toString('base64url');
    await expect(
      verifyPairingProof(pinnedApi(options), { ...pairing.identity(), identityKey: wrongKey }),
    ).rejects.toThrow();
    advertisedIdentity = { ...pairing.identity(), identityKey: wrongKey };
    await expect(verifyPairingProof(pinnedApi(options), pairing.identity())).rejects.toThrow();
  } finally {
    await close?.();
    await rm(root, { recursive: true, force: true });
  }
});
