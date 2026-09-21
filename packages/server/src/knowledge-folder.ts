import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

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
 *     ├── meetings/           recordings + transcripts
 *     ├── imports/            files kept from chat, share sheet, Drive
 *     ├── notes/              saved chat texts, spoken notes, corrections
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
 * relative path (`.text/imports/Angebot.pdf.md`). Hidden in the explorer so a
 * PDF does not appear twice; still readable by path, because the file preview
 * shows the extracted text on the file itself.
 */
export const EXTRACTED_TEXT_DIR = '.text';

/**
 * The subfolders an entry point writes into (D3). The operator never chooses
 * one: they exist so the explorer reads at a glance and an agent can
 * `ls /knowledge/meetings`.
 */
export const PROJECT_KNOWLEDGE_SUBDIRS = ['meetings', 'imports', 'notes'] as const;

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
  await mkdir(dir, { recursive: true, mode: 0o755 });
  return dir;
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
  await mkdir(dir, { recursive: true, mode: 0o755 });
  for (const sub of [...PROJECT_KNOWLEDGE_SUBDIRS, EXTRACTED_TEXT_DIR, SHARED_KNOWLEDGE_DIR]) {
    await mkdir(join(dir, sub), { recursive: true, mode: 0o755 });
  }
  return dir;
}

/**
 * The two read-only binds every sandbox of a project gets (D2), in the
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
    `${sharedKnowledgeDir(dataRoot)}:${SHARED_KNOWLEDGE_MOUNT_TARGET}:ro`,
  ];
}
