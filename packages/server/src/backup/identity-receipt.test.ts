import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decryptStream, generateBackupKeys } from './crypto.js';
import { openCaIdentityReceipt, sealCaIdentityReceipt } from './identity-receipt.js';
import { writeBackupIdentityFixture } from './testing.js';

describe('root identity helper capture receipt', () => {
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
