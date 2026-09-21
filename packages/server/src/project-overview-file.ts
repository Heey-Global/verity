import { constants as fsConstants } from 'node:fs';
import { open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PROJECT_MEMORY_MAX_CHARS, ProjectMemoryTooLargeError } from '@verity/store';

import {
  ensureProjectKnowledge,
  OVERVIEW_FILE_NAME,
  projectKnowledgeDir,
} from './knowledge-folder.js';

const appendQueues = new Map<string, Promise<unknown>>();
const migrationQueues = new Map<string, Promise<string | undefined>>();
const MIGRATION_MARKER = '.text/overview-migrated';

export async function markProjectOverviewAuthoritative(projectRoot: string): Promise<void> {
  await writeFile(join(projectRoot, MIGRATION_MARKER), '', { flag: 'a', mode: 0o644 });
}

export async function readProjectOverview(
  dataRoot: string,
  projectId: string,
): Promise<string | undefined> {
  const path = join(projectKnowledgeDir(dataRoot, projectId), OVERVIEW_FILE_NAME);
  const stats = await stat(path).catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  });
  if (stats === undefined || !stats.isFile() || stats.size > PROJECT_MEMORY_MAX_CHARS * 4)
    return undefined;
  const body = await readFile(path, 'utf8');
  const value = body?.trim();
  return value && value.length <= PROJECT_MEMORY_MAX_CHARS ? value : undefined;
}

async function appendUnlocked(dataRoot: string, projectId: string, text: string): Promise<number> {
  const addition = text.trim();
  const dir = await ensureProjectKnowledge(dataRoot, projectId);
  const path = join(dir, OVERVIEW_FILE_NAME);
  const current = (
    await readFile(path, 'utf8').catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
        return '';
      throw error;
    })
  ).trimEnd();
  if (!addition) return current.length;
  const next = current ? `${current}\n${addition}\n` : `${addition}\n`;
  const contentLength = next.trimEnd().length;
  if (contentLength > PROJECT_MEMORY_MAX_CHARS) {
    throw new ProjectMemoryTooLargeError(contentLength, PROJECT_MEMORY_MAX_CHARS);
  }
  const temporary = `${path}.${process.pid}-${Date.now()}.tmp`;
  const handle = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(next, 'utf8');
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  return next.trimEnd().length;
}

/** Append through a per-project queue so simultaneous sessions cannot lose text. */
export async function appendProjectOverview(
  dataRoot: string,
  projectId: string,
  text: string,
): Promise<number> {
  const previous = appendQueues.get(projectId) ?? Promise.resolve();
  const pending = previous
    .catch(() => undefined)
    .then(() => appendUnlocked(dataRoot, projectId, text));
  appendQueues.set(projectId, pending);
  try {
    return await pending;
  } finally {
    if (appendQueues.get(projectId) === pending) appendQueues.delete(projectId);
  }
}

/** Materialize legacy guidance once; the marker keeps a later deletion authoritative. */
export async function readOrMigrateProjectOverview(
  dataRoot: string,
  projectId: string,
  legacy: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const previous = migrationQueues.get(projectId) ?? Promise.resolve(undefined);
  const pending = previous.then(() => migrateProjectOverview(dataRoot, projectId, legacy));
  migrationQueues.set(projectId, pending);
  try {
    return await pending;
  } finally {
    if (migrationQueues.get(projectId) === pending) migrationQueues.delete(projectId);
  }
}

async function migrateProjectOverview(
  dataRoot: string,
  projectId: string,
  legacy: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const existing = await readProjectOverview(dataRoot, projectId);
  const dir = await ensureProjectKnowledge(dataRoot, projectId);
  const marker = join(dir, MIGRATION_MARKER);
  const overviewExists = await stat(join(dir, OVERVIEW_FILE_NAME))
    .then((stats) => stats.isFile())
    .catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
        return false;
      throw error;
    });
  if (overviewExists) {
    await markProjectOverviewAuthoritative(dir);
    return existing;
  }
  const migrated = await readFile(marker, 'utf8').catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  });
  if (migrated !== undefined) return undefined;
  const value = (await legacy())?.trim();
  if (value && value.length <= PROJECT_MEMORY_MAX_CHARS) {
    await appendProjectOverview(dataRoot, projectId, value);
  }
  await markProjectOverviewAuthoritative(dir);
  return value && value.length <= PROJECT_MEMORY_MAX_CHARS ? value : undefined;
}
