import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, lstat, link, unlink } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { EventStore, SessionRecord } from '@verity/store';
import { acquireKnowledgeMutationLock } from './knowledge-mutation-lock.js';
import {
  documentWorkspace,
  DOCUMENT_SESSION_DIRECTORY,
  isDocumentWorkspace,
} from './document-workspace.js';

interface Migration {
  version: 1;
  archive: string;
  destination: string;
  sessions: Array<{ id: string; source: string; view: string }>;
  stage: 'copying' | 'archived' | 'complete';
}
const excluded = new Set(['.git', '.verity-sessions', DOCUMENT_SESSION_DIRECTORY]);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function persist(path: string, value: Migration) {
  const temp = `${path}.${randomUUID()}`;
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
  const directory = await open(join(path, '..'), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Copy with exclusive destinations and byte verification. Originals, including
 * Git history, symlinks and ignored files, also survive in the full archive. */
async function copyTree(source: string, destination: string, atRoot = true): Promise<void> {
  await mkdir(destination, { recursive: true });
  const directory = await open(
    source,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (const entry of await readdir(`/proc/self/fd/${directory.fd}`, { withFileTypes: true })) {
      if (atRoot && excluded.has(entry.name)) continue;
      const from = `/proc/self/fd/${directory.fd}/${entry.name}`;
      const to = join(destination, entry.name);
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
        throw new Error(
          `Migration requires review of non-regular file: ${entry.name}; originals are unchanged`,
        );
      if (entry.isDirectory()) {
        await copyTree(from, to, false);
        continue;
      }
      const input = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await input.stat();
        const temporary = join(destination, `.migration-${randomUUID()}`);
        let output;
        try {
          output = await open(temporary, 'wx', before.mode & 0o777);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        try {
          for (;;) {
            const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            const part = buffer.subarray(0, bytesRead);
            hash.update(part);
            if (output) await output.writeFile(part);
          }
          await output?.sync();
        } finally {
          await output?.close();
        }
        try {
          await link(temporary, to);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        } finally {
          await unlink(temporary);
        }
        const destinationDirectory = await open(
          destination,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          await destinationDirectory.sync();
        } finally {
          await destinationDirectory.close();
        }
        const verify = createHash('sha256');
        const copied = await open(to, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          for (;;) {
            const { bytesRead } = await copied.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            verify.update(buffer.subarray(0, bytesRead));
          }
        } finally {
          await copied.close();
        }
        const after = await input.stat();
        if (
          hash.digest('hex') !== verify.digest('hex') ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs
        )
          throw new Error(
            `Migration copy changed or conflicts: ${entry.name}; originals are unchanged`,
          );
      } finally {
        await input.close();
      }
    }
  } finally {
    await directory.close();
  }
}

/** Call only under project lifecycle exclusion, after stopping the old sandbox.
 * A durable manifest makes filesystem and database steps retryable independently. */
export async function migrateLocalDocuments(input: {
  dataRoot: string;
  projectId: string;
  workspace: string;
  store: Pick<EventStore, 'listSessions' | 'replaceLocalSessionWorkspace'>;
}): Promise<void> {
  const { dataRoot, projectId, workspace, store } = input;
  const stateDir = join(dataRoot, 'document-migrations', projectId);
  const manifest = join(stateDir, 'manifest.json');
  let migration: Migration;
  try {
    migration = JSON.parse(await readFile(manifest, 'utf8')) as Migration;
  } catch (error) {
    if (!missing(error)) throw error;
    try {
      await lstat(join(workspace, '.git'));
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    const sessions = (await store.listSessions()).filter(
      (s: SessionRecord) => s.projectId === projectId && !isDocumentWorkspace(s.worktree),
    );
    for (const session of sessions) {
      const rel = relative(workspace, session.worktree);
      if (rel.startsWith('..') || isAbsolute(rel))
        throw new Error('Legacy session is outside the project; migration needs review', {
          cause: error,
        });
    }
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    migration = {
      version: 1,
      archive: join(dataRoot, 'document-archives', projectId, id),
      destination: `Migrated project ${id}`,
      sessions: sessions.map((s) => ({
        id: s.sessionId,
        source: s.worktree,
        view: join(workspace, DOCUMENT_SESSION_DIRECTORY, `migrated-${s.sessionId}`),
      })),
      stage: 'copying',
    };
    await persist(manifest, migration);
  }
  if (migration.stage === 'complete') return;
  const documents = join(dataRoot, 'knowledge', projectId, 'insights');
  const release = await acquireKnowledgeMutationLock(join(dataRoot, 'knowledge', projectId));
  try {
    if (migration.stage === 'copying') {
      // A crash after rename but before the phase write leaves the full source
      // at its recorded archive path. Never re-copy the new plain workspace.
      const archived = await lstat(migration.archive).then(
        () => true,
        (error: unknown) => {
          if (missing(error)) return false;
          throw error;
        },
      );
      if (!archived) {
        await copyTree(workspace, join(documents, migration.destination, 'Project'));
        // Include orphaned session directories as well as live session rows.
        const sessions = join(workspace, '.verity-sessions');
        try {
          await copyTree(sessions, join(documents, migration.destination, 'Sessions'));
        } catch (error) {
          if (!missing(error)) throw error;
        }
        await mkdir(join(dataRoot, 'document-archives', projectId), {
          recursive: true,
          mode: 0o700,
        });
        await rename(workspace, migration.archive);
      }
      migration.stage = 'archived';
      await persist(manifest, migration);
    }
    await mkdir(workspace, { recursive: true });
    await mkdir(documents, { recursive: true });
    const note = join(documents, migration.destination, 'migration.md');
    const description = `# Migrated project files\n\nProject and session files were copied and verified before the repository was archived.\n\nOriginal repository and Git history: ${migration.archive}\n\nSession working directories now contain Documents; historical paths in the conversation refer to the archived workspace.\n`;
    await mkdir(join(documents, migration.destination), { recursive: true });
    const record = await open(note, 'w', 0o644);
    try {
      await record.writeFile(description);
      await record.sync();
    } finally {
      await record.close();
    }
  } finally {
    release();
  }
  for (const session of migration.sessions) {
    await documentWorkspace(dataRoot, projectId, session.view).prepare();
    await store.replaceLocalSessionWorkspace(
      session.id,
      projectId,
      session.source,
      session.view,
      `This project now uses Documents without Git. Work in the current directory. Historical paths are archived; migrated files are under ${migration.destination}. No manual save or commit is required.`,
    );
  }
  migration.stage = 'complete';
  await persist(manifest, migration);
}
