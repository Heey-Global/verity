import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { UpdateJournal } from './update-journal.js';

export interface HostPreparation {
  readonly updateId: string;
  readonly targetDigest: string;
  readonly stage:
    'renewing' | 'registering' | 'ready' | 'restored' | 'recovery-required' | 'unchanged';
}
export function parseHostPreparation(value: unknown): HostPreparation | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(',') === 'stage,targetDigest,updateId' &&
    typeof record.updateId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(record.updateId) &&
    typeof record.targetDigest === 'string' &&
    /^ghcr\.io\/heey-global\/verity\/verity-server@sha256:[a-f0-9]{64}$/u.test(
      record.targetDigest,
    ) &&
    ['renewing', 'registering', 'ready', 'restored', 'recovery-required', 'unchanged'].includes(
      record.stage as string,
    )
    ? (record as unknown as HostPreparation)
    : null;
}
/** Separate from the closed journal/wire schema so old Servers still understand the operation. */
export async function writeHostPreparation(
  root: string,
  journal: UpdateJournal,
  stage: HostPreparation['stage'],
): Promise<void> {
  const directory = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const pinned = `/proc/self/fd/${String(directory.fd)}`;
  const temporary = join(pinned, `.host-preparation-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(
        `${JSON.stringify({ updateId: journal.updateId, targetDigest: journal.targetDigest, stage })}\n`,
      );
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(pinned, 'host-preparation.json'));
    await directory.sync();
  } finally {
    await unlink(temporary).catch(() => undefined);
    await directory.close();
  }
}
export async function readHostPreparation(
  root: string,
  journal: UpdateJournal | null,
): Promise<HostPreparation | null> {
  if (
    journal === null ||
    (journal.phase !== 'preflight' &&
      !(journal.phase === 'failed' && journal.failure?.code === 'host-runtime-failed'))
  )
    return null;
  try {
    const file = await open(
      join(root, 'host-preparation.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let raw;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 4096) return null;
      raw = await file.readFile('utf8');
    } finally {
      await file.close();
    }
    const value = parseHostPreparation(JSON.parse(raw));
    return value?.updateId === journal.updateId && value.targetDigest === journal.targetDigest
      ? value
      : null;
  } catch {
    return null;
  }
}
