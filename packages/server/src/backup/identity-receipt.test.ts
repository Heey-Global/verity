import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decryptStream, generateBackupKeys } from './crypto.js';
import { openCaIdentityReceipt, sealCaIdentityReceipt } from './identity-receipt.js';
import { writeBackupIdentityFixture } from './testing.js';

describe('root identity helper capture receipt', () => {
  it('preserves the sealed CA receipt through actual installer pairing repair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-ca-repair-'));
    try {
      const { host } = await generateBackupKeys();
      const installationId = randomUUID();
      await writeBackupIdentityFixture(root, host, installationId);
      const identity = join(root, 'identity');
      await copyFile(join(root, 'ca.pem'), join(identity, 'tls-ca-key.pem'));
      const certificate = await readFile(join(identity, 'tls-ca-cert.pem'));
      const key = await readFile(join(identity, 'tls-ca-key.pem'));
      await promisify(execFile)('bash', ['deploy/bin/verity-pairing-material'], {
        env: {
          ...process.env,
          OPENSSL_CONF: '/dev/null',
          VERITY_STATE_DIR: identity,
          VERITY_PAIRING_HOST: '127.0.0.1',
          VERITY_PAIRING_IPS: '127.0.0.1',
          VERITY_SERVER_UID: String(process.getuid?.() ?? 1000),
          VERITY_SERVER_GID: String(process.getgid?.() ?? 1000),
        },
      });
      expect(await readFile(join(identity, 'tls-ca-cert.pem'))).toEqual(certificate);
      expect(await readFile(join(identity, 'tls-ca-key.pem'))).toEqual(key);
      openCaIdentityReceipt(
        await readFile(join(root, 'ca.age')),
        await readFile(join(identity, 'tls-ca-cert.pem')),
        installationId,
        1,
        host.recipient,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('binds the encrypted CA to its certificate, installation and generation before snapshot publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-ca-receipt-'));
    try {
      const { host, recoveryKey } = await generateBackupKeys();
      const installationId = randomUUID();
      await writeBackupIdentityFixture(root, host, installationId);
      const certificate = await readFile(join(root, 'identity/tls-ca-cert.pem'));
      const receipt = await readFile(join(root, 'ca.age'));
      const ciphertext = openCaIdentityReceipt(
        receipt,
        certificate,
        installationId,
        1,
        host.recipient,
      );
      const input = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(ciphertext);
          controller.close();
        },
      });
      const restored = Buffer.from(
        await new Response(await decryptStream(recoveryKey, input)).arrayBuffer(),
      );
      expect(restored.equals(await readFile(join(root, 'ca.pem')))).toBe(true);
      restored.fill(0);
      expect(() =>
        openCaIdentityReceipt(receipt, certificate, installationId, 2, host.recipient),
      ).toThrow('does not match');
      expect(() =>
        openCaIdentityReceipt(receipt, certificate, randomUUID(), 1, host.recipient),
      ).toThrow('does not match');
      const changed = JSON.parse(receipt.toString()) as Record<string, string>;
      changed['ciphertext'] = Buffer.from('substituted ciphertext').toString('base64url');
      expect(() =>
        openCaIdentityReceipt(
          Buffer.from(JSON.stringify(changed)),
          certificate,
          installationId,
          1,
          host.recipient,
        ),
      ).toThrow('does not match');
      changed['ciphertextDigest'] = createHash('sha256')
        .update('substituted ciphertext')
        .digest('hex');
      expect(() =>
        openCaIdentityReceipt(
          Buffer.from(JSON.stringify(changed)),
          certificate,
          installationId,
          1,
          host.recipient,
        ),
      ).toThrow('does not match');
      const { host: second } = await generateBackupKeys();
      expect(() =>
        openCaIdentityReceipt(receipt, certificate, installationId, 1, second.recipient),
      ).toThrow('does not match');
      const other = join(root, 'other');
      await writeBackupIdentityFixture(other, second, installationId);
      const otherCertificate = await readFile(join(other, 'identity/tls-ca-cert.pem'));
      expect(() =>
        openCaIdentityReceipt(receipt, otherCertificate, installationId, 1, host.recipient),
      ).toThrow('does not match');
      await expect(
        sealCaIdentityReceipt(
          { recipient: host.recipient, installationId, keyGeneration: 1 },
          await readFile(join(root, 'ca.pem')),
          otherCertificate,
        ),
      ).rejects.toThrow('certificate/key mismatch');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
