import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createProjectEgressCa,
  issueGatewayServerCertificate,
  type EgressCa,
  type PemCertificate,
} from './claude-egress-ca.js';

/** Persist the public trust anchor across restarts; private CA and leaf keys never
 * enter a sandbox mount. A partial or untrusted identity fails closed. */
export async function loadForgeProxyIdentity(
  secretRoot: string,
): Promise<{ ca: EgressCa; certificate: PemCertificate }> {
  const root = join(secretRoot, 'forge-proxy');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw new Error('untrusted forge proxy identity directory');
  const certPath = join(root, 'ca.crt');
  const keyPath = join(root, 'ca.key');
  let ca: EgressCa;
  try {
    const certStat = await lstat(certPath);
    const keyStat = await lstat(keyPath);
    if (
      [certStat, keyStat].some(
        (file) =>
          !file.isFile() || file.isSymbolicLink() || file.uid !== stat.uid || file.mode & 0o077,
      )
    )
      throw new Error('untrusted forge proxy identity');
    ca = { caCertPem: await readFile(certPath, 'utf8'), caKeyPem: await readFile(keyPath, 'utf8') };
    const cert = new X509Certificate(ca.caCertPem);
    if (
      !cert.ca ||
      Date.parse(cert.validTo) <= Date.now() ||
      !cert.publicKey.equals(createPublicKey(createPrivateKey(ca.caKeyPem)))
    )
      throw new Error('invalid forge proxy identity');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Never replace half an identity: existing sandboxes may already trust it.
    for (const path of [certPath, keyPath]) {
      try {
        await lstat(path);
        throw new Error('incomplete forge proxy identity', { cause: error });
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing;
      }
    }
    ca = await createProjectEgressCa({ commonName: 'Verity forge broker CA' });
    await writeFile(keyPath, ca.caKeyPem, { mode: 0o600, flag: 'wx' });
    await writeFile(certPath, ca.caCertPem, { mode: 0o600, flag: 'wx' });
  }
  const certificate = await issueGatewayServerCertificate(ca, {
    serverName: 'github.com',
    additionalServerNames: ['api.github.com', 'uploads.github.com', 'ghcr.io'],
  });
  return { ca, certificate };
}
