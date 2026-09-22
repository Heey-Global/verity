import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  ensureProjectKnowledge,
  ensureSharedKnowledge,
  KNOWLEDGE_INSIGHTS_DIR,
} from './knowledge-folder.js';
import { assertSessionRealPath, openKnowledgeFileSlot, sessionFilePath } from './session-files.js';
import { acquireKnowledgeMutationLock } from './knowledge-mutation-lock.js';

export interface PublishSharedInsightInput {
  path: string;
  sharedPath?: string | undefined;
  expectedDigest?: string | undefined;
}

export class KnowledgePublishConflictError extends Error {
  constructor(readonly digest: string) {
    super(`shared insight already exists with digest ${digest}`);
  }
}

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function insightPath(root: string, requested: string): { abs: string; rel: string } {
  const value = sessionFilePath(join(root, KNOWLEDGE_INSIGHTS_DIR), requested);
  if (!value.rel.endsWith('.md')) throw new Error('insights must be Markdown files');
  return value;
}

/** Publish one project-authored insight into Shared without exposing either host path. */
export async function publishSharedInsight(
  dataRoot: string,
  projectId: string,
  input: PublishSharedInsightInput,
): Promise<{ path: string; digest: string; replaced: boolean }> {
  const projectRoot = await ensureProjectKnowledge(dataRoot, projectId);
  const sharedRoot = await ensureSharedKnowledge(dataRoot);
  const source = insightPath(projectRoot, input.path);
  const destination = insightPath(sharedRoot, input.sharedPath ?? input.path);
  const sourceSlot = await openKnowledgeFileSlot(
    { root: 'knowledge', dir: join(projectRoot, KNOWLEDGE_INSIGHTS_DIR) },
    source.rel,
  );
  const sourceHandle = await open(
    join(sourceSlot.directoryPath, sourceSlot.name),
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  ).catch(async (error: unknown) => {
    await sourceSlot.close();
    throw error;
  });
  let bytes: Buffer;
  try {
    const stats = await sourceHandle.stat();
    if (!stats.isFile()) throw new Error('project insight is not a regular file');
    bytes = await sourceHandle.readFile();
  } finally {
    await sourceHandle.close();
    await sourceSlot.close();
  }

  const releaseMutation = await acquireKnowledgeMutationLock(sharedRoot);
  try {
    await mkdir(dirname(destination.abs), { recursive: true, mode: 0o755 });
    await assertSessionRealPath(
      join(sharedRoot, KNOWLEDGE_INSIGHTS_DIR),
      await realpath(dirname(destination.abs)),
    );
    const existing = await lstat(destination.abs).catch(() => undefined);
    let replaced = false;
    if (existing !== undefined) {
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new Error('shared insight destination is not a regular file');
      }
      const currentDigest = digest(await readFile(destination.abs));
      if (input.expectedDigest !== currentDigest)
        throw new KnowledgePublishConflictError(currentDigest);
      replaced = true;
    } else if (input.expectedDigest !== undefined) {
      throw new Error('shared insight does not exist, so expectedDigest must be omitted');
    }

    const temporary = join(dirname(destination.abs), `.verity-publish-${randomUUID()}`);
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o644 });
      await rename(temporary, destination.abs);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return {
      path: `${KNOWLEDGE_INSIGHTS_DIR}/${destination.rel}`,
      digest: digest(bytes),
      replaced,
    };
  } finally {
    releaseMutation();
  }
}
