import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { generateBackupKeys, encryptStream } from './crypto.js';
import { verifyRestoredIdentity } from './restore-identity.js';
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('recovered deployment identity', () => {
  it('authenticates helper ciphertext against the snapshot CA and checks leaf and pairing keys without writing the raw CA', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-identity-restore-'));
    roots.push(root);
    const identity = join(root, 'identity');
    await mkdir(identity);
    await exec('openssl', [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      join(root, 'ca.pem'),
      '-out',
      join(identity, 'tls-ca-cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=Verity Test CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
    ]);
    await exec('openssl', [
      'req',
      '-new',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      join(identity, 'tls-key.pem'),
      '-out',
      join(root, 'leaf.csr'),
      '-subj',
      '/CN=Verity Test Server',
    ]);
    await exec('openssl', [
      'x509',
      '-req',
      '-in',
      join(root, 'leaf.csr'),
      '-CA',
      join(identity, 'tls-ca-cert.pem'),
      '-CAkey',
      join(root, 'ca.pem'),
      '-CAcreateserial',
      '-out',
      join(identity, 'tls-cert.pem'),
      '-days',
      '1',
    ]);
    await exec('openssl', [
      'genpkey',
      '-algorithm',
      'ED25519',
      '-out',
      join(identity, 'pairing-identity.pem'),
    ]);
    await writeFile(join(identity, 'deployment-id'), 'deployment-fixture');
    const { host, recoveryKey } = await generateBackupKeys();
    const ca = await readFile(join(root, 'ca.pem'));
    async function seal(bytes: Buffer) {
      const stream = await encryptStream(
        host.recipient,
        Readable.toWeb(Readable.from([bytes])) as ReadableStream<Uint8Array>,
      );
      await writeFile(
        join(identity, 'ca-key.age'),
        Buffer.from(await new Response(stream).arrayBuffer()),
      );
    }
    await seal(ca);
    const verified = await verifyRestoredIdentity(root, recoveryKey);
    expect(verified.deploymentId).toBe('deployment-fixture');
    expect(verified.caPrivateKey.equals(ca)).toBe(true);
    verified.caPrivateKey.fill(0);
    await expect(access(join(identity, 'tls-ca-key.pem'))).rejects.toThrow();
    await seal(await readFile(join(identity, 'tls-key.pem')));
    await expect(verifyRestoredIdentity(root, recoveryKey)).rejects.toThrow(
      'does not match its CA',
    );
    await seal(ca);
    const originalTlsKey = await readFile(join(identity, 'tls-key.pem'));
    await writeFile(join(identity, 'tls-key.pem'), ca);
    await expect(verifyRestoredIdentity(root, recoveryKey)).rejects.toThrow(
      'does not match its CA',
    );
    await writeFile(join(identity, 'tls-key.pem'), originalTlsKey);
    const corrupted = await readFile(join(identity, 'ca-key.age'));
    corrupted[corrupted.length - 1]! ^= 1;
    await writeFile(join(identity, 'ca-key.age'), corrupted);
    await expect(verifyRestoredIdentity(root, recoveryKey)).rejects.toThrow(
      'does not match its CA',
    );
  });
});
