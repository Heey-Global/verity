import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ContextConflictError, INSTRUCTIONS_MAX_CHARS } from '@verity/store';
import { ensureProjectKnowledge, projectKnowledgeDir } from './knowledge-folder.js';
import { acquireKnowledgeMutationLock } from './knowledge-mutation-lock.js';

export async function readProjectInstructions(
  dataRoot: string,
  projectId: string,
): Promise<{ instructions: string; revision: string }> {
  await ensureProjectKnowledge(dataRoot, projectId);
  return readInstructionsFile(projectKnowledgeDir(dataRoot, projectId));
}

async function readInstructionsFile(
  root: string,
): Promise<{ instructions: string; revision: string }> {
  let instructions = '';
  const handle = await open(
    join(root, 'AGENTS.md'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (handle) {
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > INSTRUCTIONS_MAX_CHARS * 4)
        throw new Error('Invalid project Instructions file');
      instructions = await handle.readFile('utf8');
      if (instructions.length > INSTRUCTIONS_MAX_CHARS)
        throw new Error('Project Instructions exceeds its character limit');
    } finally {
      await handle.close();
    }
  }
  return { instructions, revision: createHash('sha256').update(instructions).digest('hex') };
}

export async function replaceProjectInstructions(
  dataRoot: string,
  projectId: string,
  expectedRevision: string,
  instructions: string,
) {
  if (instructions.length > INSTRUCTIONS_MAX_CHARS)
    throw new RangeError('Project Instructions exceeds its character limit');
  const root = await ensureProjectKnowledge(dataRoot, projectId);
  const release = await acquireKnowledgeMutationLock(root);
  const temporary = join(root, `.instructions-${randomUUID()}.tmp`);
  try {
    const current = await readInstructionsFile(root);
    if (current.revision !== expectedRevision)
      throw new ContextConflictError('Project Instructions changed; reload before saving');
    const handle = await open(temporary, 'wx', 0o644);
    try {
      await handle.writeFile(instructions);
    } finally {
      await handle.close();
    }
    await rename(temporary, join(root, 'AGENTS.md'));
    return await readInstructionsFile(root);
  } finally {
    await unlink(temporary).catch(() => undefined);
    release();
  }
}
