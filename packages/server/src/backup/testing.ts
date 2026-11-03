import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { BackupHostKeys } from './crypto.js';
import { sealCaIdentityReceipt } from './identity-receipt.js';
const exec = promisify(execFile);

/** Real certificate/key fixture shared by capture and restore integration checks. */
export async function writeBackupIdentityFixture(
  root: string,
  host: BackupHostKeys,
  installationId: string,
): Promise<void> {
  const identity = join(root, 'identity');
  await mkdir(identity, { recursive: true });
  const env = { ...process.env, OPENSSL_CONF: '/dev/null' };
  await exec(
    'openssl',
    [
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
      '3650',
      '-subj',
      '/CN=Verity Backup Test CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
    ],
    { env },
  );
  await exec(
    'openssl',
    [
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
      '/CN=Verity Backup Test Server',
    ],
    { env },
  );
  await exec(
    'openssl',
    [
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
      '397',
    ],
    { env },
  );
  const pair = generateKeyPairSync('ed25519');
  await writeFile(
    join(identity, 'pairing-identity.pem'),
    pair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
  );
  await writeFile(join(identity, 'deployment-id'), 'deployment-fixture');
  const ca = await readFile(join(root, 'ca.pem'));
  try {
    await writeFile(
      join(root, 'ca.age'),
      await sealCaIdentityReceipt(
        { recipient: host.recipient, installationId, keyGeneration: 1 },
        ca,
        await readFile(join(identity, 'tls-ca-cert.pem')),
      ),
    );
  } finally {
    ca.fill(0);
  }
}
