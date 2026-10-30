import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { posix } from 'node:path';

export interface BackupHostPlan {
  version: 1;
  statePath: string;
  backupPath: string;
  identityPath: string;
  provisioned: boolean;
}

export function safeHostPath(value: string): boolean {
  return /^\/[A-Za-z0-9/_.-]+$/.test(value) && posix.normalize(value) === value && value !== '/';
}

async function small(path: string, owner: number): Promise<string | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > 1024 || info.uid !== owner || info.mode & 0o022)
      throw new Error('Invalid backup host state');
    return (await file.readFile('utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await file?.close();
  }
}

/** Only the sealed pairing bind selects the root; no request selects a host source. */
export async function readBackupHostPlan(
  statePath: string,
  identityPath = '/var/lib/verity/backup-identity',
  owner = 0,
): Promise<BackupHostPlan> {
  if (!safeHostPath(statePath) || !safeHostPath(identityPath))
    throw new Error('Unsafe backup host path');
  const info = await lstat(statePath);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== owner || info.mode & 0o022)
    throw new Error('Backup installer state must be a protected directory');
  const backupPath = (await small(`${statePath}/backup-dir`, owner)) ?? '/var/lib/verity/backups';
  if (
    !safeHostPath(backupPath) ||
    backupPath === statePath ||
    statePath.startsWith(`${backupPath}/`) ||
    backupPath.startsWith(`${statePath}/`) ||
    backupPath === identityPath ||
    identityPath.startsWith(`${backupPath}/`) ||
    backupPath.startsWith(`${identityPath}/`) ||
    /^\/(etc|usr|run|proc|sys|dev)(\/|$)/.test(backupPath)
  )
    throw new Error('Unsafe backup destination');
  const receipt = await small(`${statePath}/backup-provisioning-version`, owner);
  return { version: 1, statePath, backupPath, identityPath, provisioned: receipt === '1' };
}
