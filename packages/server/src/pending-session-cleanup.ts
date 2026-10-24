import { mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sessionHomePath } from './session-home.js';

export interface PendingSessionCleanup {
  sessionId: string;
  sandboxCwd: string;
  runnerProjectIds: string[];
  bindings: { backend: string; backendSessionId: string }[];
}

function recordPath(root: string, id: string): string {
  return `${sessionHomePath(root, id)}.json`;
}

/** Outside session foreign-key cascades: a failed cleanup must retain ownership. */
export async function queueSessionCleanup(
  root: string,
  record: PendingSessionCleanup,
): Promise<void> {
  await mkdir(join(root, 'session-homes'), { recursive: true, mode: 0o700 });
  const path = recordPath(root, record.sessionId);
  const temporary = `${path}.${randomUUID()}`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(record));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function finishSessionCleanup(root: string, id: string): Promise<void> {
  await rm(recordPath(root, id), { force: true });
}

export async function pendingSessionCleanups(root: string): Promise<PendingSessionCleanup[]> {
  const directory = join(root, 'session-homes');
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const records: PendingSessionCleanup[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
    const file = await open(join(directory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await file.stat()).size > 65536) throw new Error('Invalid pending session cleanup');
      const record = JSON.parse(await file.readFile('utf8')) as PendingSessionCleanup;
      if (
        recordPath(root, record.sessionId) !== join(directory, entry.name) ||
        typeof record.sandboxCwd !== 'string' ||
        !Array.isArray(record.bindings) ||
        !Array.isArray(record.runnerProjectIds) ||
        record.runnerProjectIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id))
      )
        throw new Error('Invalid pending session cleanup');
      records.push(record);
    } finally {
      await file.close();
    }
  }
  return records;
}
