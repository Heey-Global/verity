import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface BackupCapabilities {
  available: boolean;
  reason?: string;
  installationId?: string;
  targetId?: string;
}

async function readSmallRegular(path: string, maximum: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maximum) throw new Error('Invalid backup capability file');
    const bytes = Buffer.alloc(maximum + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maximum) throw new Error('Backup capability exceeds limit');
    return bytes.subarray(0, bytesRead).toString('utf8').trim();
  } finally {
    await file.close();
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Detect actual installer resources rather than assuming the release implies a migrated host. */
export async function readBackupCapabilities(paths: {
  pairing: string;
  destination: string;
  identityRequests: string;
}): Promise<BackupCapabilities> {
  try {
    const installationId = await readSmallRegular(join(paths.pairing, 'installation-id'), 128);
    const targetId = await readSmallRegular(join(paths.destination, '.verity-backup-target'), 128);
    const password = await readSmallRegular(join(paths.pairing, 'backup-postgres-password'), 128);
    if (!UUID.test(installationId) || !UUID.test(targetId) || !/^[0-9a-f]{64}$/.test(password))
      throw new Error('Incomplete backup prerequisites');
    const requests = await stat(paths.identityRequests);
    if (!requests.isDirectory()) throw new Error('Missing backup identity helper directory');
    return { available: true, installationId, targetId };
  } catch {
    return {
      available: false,
      reason:
        'Run the installer to provision backup mounts, installation identity and database access.',
    };
  }
}

export async function backupDatabaseUrl(
  databaseUrl: string,
  pairingDirectory: string,
): Promise<string> {
  const password = await readSmallRegular(join(pairingDirectory, 'backup-postgres-password'), 128);
  if (!/^[0-9a-f]{64}$/.test(password)) throw new Error('Invalid backup database credential');
  const url = new URL(databaseUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
    throw new Error('Backup requires PostgreSQL');
  url.username = 'verity_backup';
  url.password = password;
  // Preserve connection/TLS parameters but never inherit session SQL overrides from a privileged connection.
  url.searchParams.delete('options');
  // node-postgres gives query credentials precedence over URL userinfo.
  url.searchParams.delete('user');
  url.searchParams.delete('password');
  return url.toString();
}
