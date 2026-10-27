import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { chmod, chown, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { openBackupPath } from './git.js';
import { readBounded, writeDurable } from './repository.js';
import type { RestoreStagingDependencies } from './restore-staging.js';
const exec = promisify(execFile);

/** Generate host credentials in private staging; never run the normal helper's CA rotation path. */
export function createRestoreHost(options: {
  root: string;
  addresses: readonly string[];
  hostname?: string;
  project?: string;
  backupDirectory?: string;
  serverUid?: number;
  serverGid?: number;
}): RestoreStagingDependencies['stageHost'] {
  const names = ['DNS:localhost', 'IP:127.0.0.1'];
  for (const address of options.addresses) {
    if (!isIP(address)) throw new Error('Invalid recovery TLS address');
    names.push(`IP:${address}`);
  }
  if (options.hostname) {
    if (!isIP(options.hostname) && !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(options.hostname))
      throw new Error('Invalid recovery TLS hostname');
    names.push(`${isIP(options.hostname) ? 'IP' : 'DNS'}:${options.hostname}`);
  }
  const project = options.project ?? 'verity';
  const backupDirectory = options.backupDirectory ?? '/var/lib/verity/backups';
  if (
    !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(project) ||
    !/^\/[A-Za-z0-9/_.-]+$/.test(backupDirectory) ||
    backupDirectory === '/' ||
    backupDirectory.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error('Invalid recovery host configuration');
  const uid = options.serverUid ?? 1000;
  const gid = options.serverGid ?? 1000;
  if (![uid, gid].every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new Error('Invalid recovery credential owner');
  return async (job, tree, caPrivateKey, signal) => {
    signal?.throwIfAborted();
    if (!job.verified) throw new Error('Verified deployment identity required');
    const database: unknown = JSON.parse(
      (await readBounded(join(options.root, job.id, 'database'), 16384)).toString(),
    );
    if (
      !database ||
      typeof database !== 'object' ||
      !('jobId' in database) ||
      database.jobId !== job.id ||
      !('password' in database) ||
      typeof database.password !== 'string' ||
      !/^[a-f0-9]{64}$/.test(database.password)
    )
      throw new Error('Restore database credentials invalid');
    const root = join(options.root, job.id, 'host');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const save = async (name: string, bytes: Buffer | string) => {
      signal?.throwIfAborted();
      await writeDurable(join(root, name), Buffer.from(bytes), false);
    };
    const openssl = async (args: string[]) => {
      signal?.throwIfAborted();
      try {
        await exec('openssl', args, {
          ...(signal ? { signal } : {}),
          timeout: 30000,
          maxBuffer: 64 * 1024,
        });
      } catch {
        throw new Error('Recovery host certificate preparation failed');
      }
    };
    let deploymentId: string;
    if (job.selection.newIdentity) {
      deploymentId = randomUUID();
      const pairing = generateKeyPairSync('ed25519').privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      });
      await save('pairing-identity.pem', pairing);
      const ca = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      });
      await save('tls-ca-key.pem', ca);
      await openssl([
        'req',
        '-new',
        '-x509',
        '-sha256',
        '-days',
        '3650',
        '-key',
        join(root, 'tls-ca-key.pem'),
        '-out',
        join(root, 'tls-ca-cert.pem'),
        '-subj',
        '/CN=Verity local pairing CA',
        '-addext',
        'basicConstraints=critical,CA:TRUE,pathlen:0',
        '-addext',
        'keyUsage=critical,keyCertSign,cRLSign',
      ]);
    } else {
      if (!job.verified) throw new Error('Verified deployment identity required');
      deploymentId = job.verified.deploymentId;
      for (const name of ['pairing-identity.pem', 'tls-ca-cert.pem']) {
        const file = await openBackupPath(tree, 'identity/' + name, false);
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > 1024 * 1024)
            throw new Error('Invalid restored host identity');
          await save(name, await file.readFile());
        } finally {
          await file.close();
        }
      }
      const ca = new X509Certificate(await readFile(join(root, 'tls-ca-cert.pem')));
      if (Date.parse(ca.validTo) <= Date.now())
        throw new Error('Recovered CA expired; preserved identity cannot be activated');
      await save('tls-ca-key.pem', caPrivateKey);
    }
    const leaf = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    });
    await save('tls-key.pem', leaf);
    const csr = join(root, 'tls.csr');
    try {
      await openssl([
        'req',
        '-new',
        '-sha256',
        '-key',
        join(root, 'tls-key.pem'),
        '-out',
        csr,
        '-subj',
        '/CN=Verity server',
        '-addext',
        `subjectAltName=${names.join(',')}`,
      ]);
      await openssl([
        'x509',
        '-req',
        '-in',
        csr,
        '-CA',
        join(root, 'tls-ca-cert.pem'),
        '-CAkey',
        join(root, 'tls-ca-key.pem'),
        '-set_serial',
        '0x' + randomBytes(16).toString('hex'),
        '-days',
        '365',
        '-sha256',
        '-copy_extensions',
        'copy',
        '-out',
        join(root, 'tls-cert.pem'),
      ]);
    } finally {
      await rm(csr, { force: true });
    }
    await save('deployment-id', deploymentId);
    await save('installation-id', job.installationId);
    await save('postgres-password', database.password);
    await save('backup-postgres-password', randomBytes(32).toString('hex'));
    await save('compose-project', project);
    await save('backup-dir', backupDirectory);
    await save('backup-server-image', job.verified.image);
    for (const name of ['installation-id', 'compose-project', 'backup-dir'])
      await chmod(join(root, name), 0o644);
    if (process.getuid?.() === 0) await chown(join(root, 'backup-postgres-password'), uid, gid);
    await save('updater-token', randomBytes(32).toString('hex'));
    // Pairing remains unavailable in trial; acceptance can create a fresh pairing code later.
    for (const name of [
      'pairing-identity.pem',
      'tls-key.pem',
      'tls-cert.pem',
      'tls-ca-cert.pem',
      'deployment-id',
    ])
      if (process.getuid?.() === 0) await chown(join(root, name), uid, gid);
    await chmod(root, 0o711);
    signal?.throwIfAborted();
  };
}
