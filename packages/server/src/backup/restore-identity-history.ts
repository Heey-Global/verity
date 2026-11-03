import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { createHash, X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import { openBackupPath } from './git.js';

/** Root-only rotation history fences snapshots without changing or trusting their archived metadata. */
export async function assertRestorableIdentity(
  hostRoot: string,
  tree: string,
  newIdentity: boolean,
): Promise<void> {
  if (newIdentity) return;
  const path = join(hostRoot, 'retired-identity-ca-sha256');
  let history;
  try {
    history = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      await lstat(join(hostRoot, 'identity-rotation'));
    } catch (markerError) {
      if ((markerError as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw markerError;
    }
    throw new Error('Identity rotation history is missing; restore requires --new-identity', {
      cause: error,
    });
  }
  try {
    const info = await history.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o022 ||
      info.size > 1024 * 1024
    )
      throw new Error('Unsafe identity rotation history; restore requires --new-identity');
    const encoded = await history.readFile('utf8');
    const fingerprints = encoded.trim().split('\n');
    if (!fingerprints.length || fingerprints.some((value) => !/^[a-f0-9]{64}$/.test(value)))
      throw new Error('Invalid identity rotation history; restore requires --new-identity');
    const certificate = await openBackupPath(tree, 'identity/tls-ca-cert.pem', false);
    try {
      const stat = await certificate.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid snapshot CA');
      const ca = new X509Certificate(await certificate.readFile());
      const fingerprint = createHash('sha256').update(ca.raw).digest('hex');
      if (fingerprints.includes(fingerprint))
        throw new Error('Snapshot identity was retired; restore requires --new-identity');
    } finally {
      await certificate.close();
    }
  } finally {
    await history.close();
  }
}
