import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readdir, rename, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { acquireKnowledgeMutationLock } from './knowledge-mutation-lock.js';

/**
 * The knowledge folder layout (ADR 0022 D1).
 *
 * A project's knowledge is a directory on the server, not a database-backed
 * library: the server owns it, the session explorer browses it, and every
 * sandbox of the project sees it as a READ-ONLY mount (D2). The folder is the
 * source of truth — nothing here is derived from a table, and the later
 * retrieval index (D4) is derived from these files rather than the other way
 * round.
 *
 * ```
 * <dataRoot>/knowledge/
 * ├── shared/                 readable by every project
 * └── <projectId>/
 *     ├── overview.md         the project's short memory (D5)
 *     ├── sources/            immutable source material
 *     │   ├── documents/      chat, share sheet, Drive, web
 *     │   └── meetings/       recordings + transcripts
 *     ├── insights/           agent- and operator-authored knowledge
 *     ├── .text/              extracted text per file (hidden in the explorer)
 *     └── shared/             EMPTY — the mount point for the shared folder
 * ```
 */

/** Directory under the Verity data root holding every knowledge folder. */
const KNOWLEDGE_ROOT_DIR = 'knowledge';

/**
 * The shared folder's name — both its directory under the knowledge root and the
 * mount point a project folder carries for it, so the sandbox path is
 * `/knowledge/shared`. Never a project id: ids are UUIDs, and
 * {@link assertKnowledgeProjectId} refuses this name outright.
 */
export const SHARED_KNOWLEDGE_DIR = 'shared';

/**
 * Extracted, machine-readable text per file (D4), mirrored under the same
 * relative path (`.text/sources/documents/Angebot.pdf.md`). Hidden in the explorer so a
 * PDF does not appear twice; still readable by path, because the file preview
 * shows the extracted text on the file itself.
 */
export const EXTRACTED_TEXT_DIR = '.text';

const KNOWLEDGE_SOURCES_DIR = 'sources';
const SHARED_LAYOUT_MARKER = '.sources-layout-v1';
export const KNOWLEDGE_DOCUMENTS_DIR = `${KNOWLEDGE_SOURCES_DIR}/documents`;
export const KNOWLEDGE_MEETINGS_DIR = `${KNOWLEDGE_SOURCES_DIR}/meetings`;
export const KNOWLEDGE_INSIGHTS_DIR = 'insights';

/**
 * The subfolders an entry point writes into (D3). The operator never chooses
 * one: they exist so the explorer reads at a glance and an agent can
 * `ls /knowledge/meetings`.
 */
export const PROJECT_KNOWLEDGE_SUBDIRS = [
  KNOWLEDGE_DOCUMENTS_DIR,
  KNOWLEDGE_MEETINGS_DIR,
  KNOWLEDGE_INSIGHTS_DIR,
] as const;
export const PROJECT_KNOWLEDGE_TOP_LEVEL_DIRS = [
  KNOWLEDGE_SOURCES_DIR,
  KNOWLEDGE_INSIGHTS_DIR,
] as const;

/** The project's short memory, injected into every session (D5). */
export const OVERVIEW_FILE_NAME = 'overview.md';

/** Where a project folder is mounted inside every one of its sandboxes. */
export const KNOWLEDGE_MOUNT_TARGET = '/knowledge';

/** Where the shared folder is mounted, nested inside {@link KNOWLEDGE_MOUNT_TARGET}. */
const SHARED_KNOWLEDGE_MOUNT_TARGET = `${KNOWLEDGE_MOUNT_TARGET}/${SHARED_KNOWLEDGE_DIR}`;

/**
 * Project ids are app-generated UUIDs, so anything outside this alphabet is
 * either a bug or an attempt to steer the join below out of the knowledge root.
 * Refused rather than sanitized: a caller that cannot name a project has no
 * business getting *some* directory back.
 */
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function assertKnowledgeProjectId(projectId: string): void {
  if (!PROJECT_ID_PATTERN.test(projectId) || projectId === SHARED_KNOWLEDGE_DIR) {
    throw new Error(`invalid project id for a knowledge folder: ${JSON.stringify(projectId)}`);
  }
}

/** `<dataRoot>/knowledge`. */
export function knowledgeRootDir(dataRoot: string): string {
  return join(dataRoot, KNOWLEDGE_ROOT_DIR);
}

/** `<dataRoot>/knowledge/<projectId>`. */
export function projectKnowledgeDir(dataRoot: string, projectId: string): string {
  assertKnowledgeProjectId(projectId);
  return join(knowledgeRootDir(dataRoot), projectId);
}

/** `<dataRoot>/knowledge/shared`. */
export function sharedKnowledgeDir(dataRoot: string): string {
  return join(knowledgeRootDir(dataRoot), SHARED_KNOWLEDGE_DIR);
}

/**
 * Create the shared folder if it is missing and return it.
 *
 * `0o755`: the sandbox agent runs as a different uid than the server and reads
 * this through a read-only mount, so world-read/execute is what makes the mount
 * usable at all. Nothing secret belongs here — `shared/` is readable by every
 * project by definition (D1).
 */
export async function ensureSharedKnowledge(dataRoot: string): Promise<string> {
  const dir = sharedKnowledgeDir(dataRoot);
  const releaseMutation = await acquireKnowledgeMutationLock(dir);
  try {
    await mkdir(dir, { recursive: true, mode: 0o755 });
    const marker = join(dir, EXTRACTED_TEXT_DIR, SHARED_LAYOUT_MARKER);
    const needsMigration = !(await stat(marker).catch(() => undefined));
    if (needsMigration) {
      await migrateLegacyKnowledgeDirectory(dir, 'imports', KNOWLEDGE_DOCUMENTS_DIR);
      await migrateLegacyKnowledgeDirectory(dir, 'meetings', KNOWLEDGE_MEETINGS_DIR);
      await migrateLegacyKnowledgeDirectory(dir, 'notes', KNOWLEDGE_INSIGHTS_DIR);
    }
    for (const sub of [...PROJECT_KNOWLEDGE_SUBDIRS, EXTRACTED_TEXT_DIR]) {
      await mkdir(join(dir, sub), { recursive: true, mode: 0o755 });
    }
    if (needsMigration) {
      await migrateLegacySharedEntries(dir);
      await writeFile(marker, '', { flag: 'a', mode: 0o644 });
    }
    return dir;
  } finally {
    releaseMutation();
  }
}

/**
 * Create a project's knowledge folder with its fixed subfolders and return it.
 * Idempotent, so provisioning can call it on every pass.
 *
 * The empty `shared/` directory is the mount point for the shared folder and
 * the reason it must exist on disk: `/knowledge` is mounted read-only, and a
 * container runtime cannot create a missing mount point inside a read-only
 * mount — the container would fail to start instead. The explorer hides it
 * (it has a Shared root of its own), and nothing ever writes into it: what the
 * sandbox sees there comes from the nested mount, not from this directory.
 */
export async function ensureProjectKnowledge(dataRoot: string, projectId: string): Promise<string> {
  const dir = projectKnowledgeDir(dataRoot, projectId);
  const releaseMutation = await acquireKnowledgeMutationLock(dir);
  try {
    await mkdir(dir, { recursive: true, mode: 0o755 });
    await migrateLegacyKnowledgeDirectory(dir, 'imports', KNOWLEDGE_DOCUMENTS_DIR);
    await migrateLegacyKnowledgeDirectory(dir, 'meetings', KNOWLEDGE_MEETINGS_DIR);
    await migrateLegacyKnowledgeDirectory(dir, 'notes', KNOWLEDGE_INSIGHTS_DIR);
    for (const sub of [...PROJECT_KNOWLEDGE_SUBDIRS, EXTRACTED_TEXT_DIR, SHARED_KNOWLEDGE_DIR]) {
      await mkdir(join(dir, sub), { recursive: true, mode: 0o755 });
    }
    // The sandbox's non-root agent writes only through this nested read-write bind.
    // The project directory itself remains read-only in the sandbox, so widening
    // this host directory cannot make sources, overview, or mount points mutable.
    await makeInsightsWritable(join(dir, KNOWLEDGE_INSIGHTS_DIR));
    return dir;
  } finally {
    releaseMutation();
  }
}

async function makeInsightsWritable(path: string): Promise<void> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    await makeInsightsHandleWritable(handle);
  } finally {
    await handle.close();
  }
}

async function makeInsightsHandleWritable(handle: Awaited<ReturnType<typeof open>>): Promise<void> {
  await handle.chmod(0o777);
  const directoryPath = `/proc/self/fd/${String(handle.fd)}`;
  for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
    const child = await open(
      join(directoryPath, entry.name),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    ).catch(() => undefined);
    if (child === undefined) continue;
    try {
      const stats = await child.stat();
      if (stats.isDirectory()) await makeInsightsHandleWritable(child);
      else if (stats.isFile()) await child.chmod(0o666);
    } finally {
      await child.close();
    }
  }
}

/**
 * The project root and Shared are read-only; a deeper read-write bind exposes
 * only project insights. Returned in the
 * `host:target:mode` form the provisioner partitions into host binds or
 * named-volume subpaths. Both paths live under the data volume root, so a
 * deployment with a named data volume resolves them by volume name.
 *
 * Order matters only to a reader: container runtimes sort mounts by target
 * depth, so `/knowledge` is established before `/knowledge/shared` lands on the
 * mount point inside it.
 */
export function knowledgeSandboxBinds(dataRoot: string | undefined, projectId: string): string[] {
  if (dataRoot === undefined || dataRoot.length === 0) return [];
  return [
    `${projectKnowledgeDir(dataRoot, projectId)}:${KNOWLEDGE_MOUNT_TARGET}:ro`,
    `${join(projectKnowledgeDir(dataRoot, projectId), KNOWLEDGE_INSIGHTS_DIR)}:${KNOWLEDGE_MOUNT_TARGET}/${KNOWLEDGE_INSIGHTS_DIR}`,
    `${sharedKnowledgeDir(dataRoot)}:${SHARED_KNOWLEDGE_MOUNT_TARGET}:ro`,
  ];
}

async function migrateLegacyDirectory(
  root: string,
  legacy: string,
  current: string,
): Promise<void> {
  const from = join(root, legacy);
  const to = join(root, current);
  if (!(await stat(from).catch(() => undefined))) return;
  if (!(await stat(to).catch(() => undefined))) {
    await mkdir(join(to, '..'), { recursive: true, mode: 0o755 });
    await renameAfterConcurrentCheck(from, to);
    return;
  }
  await mergeLegacyDirectory(from, to);
}

async function migrateLegacyKnowledgeDirectory(
  root: string,
  legacy: string,
  current: string,
): Promise<void> {
  const from = join(root, legacy);
  const to = join(root, current);
  if (!(await stat(from).catch(() => undefined))) {
    await migrateLegacyDirectory(join(root, EXTRACTED_TEXT_DIR), legacy, current);
    return;
  }
  await mkdir(to, { recursive: true, mode: 0o755 });
  await mergeLegacyKnowledgeEntries(
    from,
    to,
    join(root, EXTRACTED_TEXT_DIR, legacy),
    join(root, EXTRACTED_TEXT_DIR, current),
  );
  await migrateLegacyDirectory(join(root, EXTRACTED_TEXT_DIR), legacy, current);
}

async function mergeLegacyKnowledgeEntries(
  from: string,
  to: string,
  extractedFrom: string,
  extractedTo: string,
): Promise<void> {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const requestedDestination = join(to, entry.name);
    const destinationStats = await stat(requestedDestination).catch(() => undefined);
    if (entry.isDirectory()) {
      const destination =
        destinationStats === undefined || destinationStats.isDirectory()
          ? requestedDestination
          : await availableLegacyPath(requestedDestination);
      await mkdir(destination, { recursive: true, mode: 0o755 });
      await mergeLegacyKnowledgeEntries(
        source,
        destination,
        join(extractedFrom, entry.name),
        join(extractedTo, basename(destination)),
      );
      continue;
    }
    const destination =
      destinationStats === undefined
        ? requestedDestination
        : await availableLegacyPath(requestedDestination);
    await renameAfterConcurrentCheck(source, destination);
    const extractedSource = join(extractedFrom, `${entry.name}.md`);
    if (await stat(extractedSource).catch(() => undefined)) {
      const extractedDestination = join(extractedTo, `${basename(destination)}.md`);
      await mkdir(join(extractedDestination, '..'), { recursive: true, mode: 0o755 });
      await renameAfterConcurrentCheck(extractedSource, extractedDestination);
    }
  }
  await rmdir(from).catch(() => undefined);
  await rmdir(extractedFrom).catch(() => undefined);
}

async function mergeLegacyDirectory(from: string, to: string): Promise<void> {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const destination = join(to, entry.name);
    const destinationStats = await stat(destination).catch(() => undefined);
    if (destinationStats === undefined) {
      await renameAfterConcurrentCheck(source, destination);
    } else if (entry.isDirectory() && destinationStats.isDirectory()) {
      await mergeLegacyDirectory(source, destination);
    } else {
      await renameAfterConcurrentCheck(source, await availableLegacyPath(destination));
    }
  }
  await rmdir(from).catch(() => undefined);
}

async function availableLegacyPath(path: string): Promise<string> {
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${path}.legacy-${String(suffix)}`;
    if (!(await stat(candidate).catch(() => undefined))) return candidate;
  }
}

async function migrateLegacySharedEntries(root: string): Promise<void> {
  const reserved = new Set([KNOWLEDGE_SOURCES_DIR, KNOWLEDGE_INSIGHTS_DIR, EXTRACTED_TEXT_DIR]);
  const destination = join(root, KNOWLEDGE_DOCUMENTS_DIR);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (reserved.has(entry.name)) continue;
    const target = join(destination, entry.name);
    if (await stat(target).catch(() => undefined)) continue;
    await renameAfterConcurrentCheck(join(root, entry.name), target);
  }
  const extractedRoot = join(root, EXTRACTED_TEXT_DIR);
  const extractedDestination = join(extractedRoot, KNOWLEDGE_DOCUMENTS_DIR);
  await mkdir(extractedDestination, { recursive: true, mode: 0o755 });
  for (const entry of await readdir(extractedRoot, { withFileTypes: true })) {
    if (entry.name === KNOWLEDGE_SOURCES_DIR || entry.name === KNOWLEDGE_INSIGHTS_DIR) continue;
    const target = join(extractedDestination, entry.name);
    if (await stat(target).catch(() => undefined)) continue;
    await renameAfterConcurrentCheck(join(extractedRoot, entry.name), target);
  }
}

async function renameAfterConcurrentCheck(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    const source = await stat(from).catch(() => undefined);
    const destination = await stat(to).catch(() => undefined);
    if (source === undefined && destination !== undefined) return;
    throw error;
  }
}
