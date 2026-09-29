import { constants as fsConstants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  ensureProjectKnowledge,
  KNOWLEDGE_DOCUMENTS_DIR,
  KNOWLEDGE_MEETINGS_DIR,
} from './knowledge-folder.js';
import { ingestKnowledgeBytes } from './knowledge-file-ingest.js';
import { assertSessionRealPath, openKnowledgeFileSlot, sessionFilePath } from './session-files.js';

const MAX_SOURCE_BYTES = 10_000_000;

export interface ImportProjectSourceInput {
  sourcePath: string;
  destination: 'meetings' | 'documents';
  path: string;
}

/** Copy a session file into its own project's protected Sources folder. */
export async function importProjectSource(
  dataRoot: string,
  projectId: string,
  worktree: string,
  input: ImportProjectSourceInput,
): Promise<{ path: string; size: number }> {
  const source = await openKnowledgeFileSlot({ root: 'worktree', dir: worktree }, input.sourcePath);
  let bytes: Buffer;
  try {
    const handle = await open(
      join(source.directoryPath, source.name),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new Error('source must be a regular file');
      if (stats.size > MAX_SOURCE_BYTES) throw new Error('source exceeds the 10 MB import limit');
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } finally {
    await source.close();
  }
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error('source exceeds the 10 MB import limit');

  const root = await ensureProjectKnowledge(dataRoot, projectId);
  const folder =
    input.destination === 'meetings' ? KNOWLEDGE_MEETINGS_DIR : KNOWLEDGE_DOCUMENTS_DIR;
  const destination = sessionFilePath(join(root, folder), input.path);
  if (!destination.rel || destination.rel.startsWith('.')) throw new Error('invalid source path');
  // The destination folder is managed by Verity; refuse symlinked parents even
  // if one was introduced outside the explorer after the layout was created.
  await assertSessionRealPath(root, await realpath(dirname(destination.abs)));
  const path = await ingestKnowledgeBytes(root, `${folder}/${destination.rel}`, bytes);
  return { path, size: bytes.length };
}
