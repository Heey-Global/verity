import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  ensureProjectKnowledge,
  KNOWLEDGE_DOCUMENTS_DIR,
  KNOWLEDGE_MEETINGS_DIR,
} from './knowledge-folder.js';
import {
  extractKnowledgeFile,
  ingestKnowledgeBytes,
  moveKnowledgeExtraction,
} from './knowledge-file-ingest.js';
import { assertSessionRealPath, openKnowledgeFileSlot, sessionFilePath } from './session-files.js';

const MAX_SOURCE_BYTES = 10_000_000;
type SourceFolder = 'meetings' | 'documents';

function sourceFolder(destination: SourceFolder): string {
  return destination === 'meetings' ? KNOWLEDGE_MEETINGS_DIR : KNOWLEDGE_DOCUMENTS_DIR;
}

function checkedPath(path: string): string {
  if (
    !path ||
    path.length > 512 ||
    path
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part.startsWith('.') ||
          part.includes('\\') ||
          part.includes('\0') ||
          Buffer.byteLength(part) > 255,
      )
  )
    throw new Error('invalid source path');
  return path;
}

async function ensureSourceDirectory(root: string, relative: string, create = true): Promise<void> {
  let current = root;
  for (const part of relative.split('/')) {
    const parent = await open(
      current,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    try {
      await assertSessionRealPath(root, await realpath(`/proc/self/fd/${String(parent.fd)}`));
      const child = `/proc/self/fd/${String(parent.fd)}/${part}`;
      if (create)
        await mkdir(child).catch((error: unknown) => {
          if ((error as { code?: string }).code !== 'EEXIST') throw error;
        });
      if ((await lstat(child)).isSymbolicLink()) throw new Error('source directory is a symlink');
      const next = await open(
        child,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
      try {
        current = await realpath(`/proc/self/fd/${String(next.fd)}`);
        await assertSessionRealPath(root, current);
      } finally {
        await next.close();
      }
    } finally {
      await parent.close();
    }
  }
}

export async function createProjectSourceFolder(
  dataRoot: string,
  projectId: string,
  input: { destination: SourceFolder; path: string },
): Promise<{ path: string }> {
  const root = await ensureProjectKnowledge(dataRoot, projectId);
  const path = `${sourceFolder(input.destination)}/${checkedPath(input.path)}`;
  await ensureSourceDirectory(root, path);
  return { path };
}

export async function moveProjectSource(
  dataRoot: string,
  projectId: string,
  input: { sourcePath: string; destination: SourceFolder; path: string },
): Promise<{ path: string }> {
  const root = await ensureProjectKnowledge(dataRoot, projectId);
  const from = checkedPath(input.sourcePath);
  if (!from.startsWith('meetings/') && !from.startsWith('documents/'))
    throw new Error('invalid source path');
  const sourcePath = `sources/${from}`;
  const targetPath = `${sourceFolder(input.destination)}/${checkedPath(input.path)}`;
  if (sourcePath === targetPath) throw new Error('source and destination are the same');
  await ensureSourceDirectory(root, dirname(sourcePath), false);
  await ensureSourceDirectory(root, dirname(targetPath));
  const source = await openKnowledgeFileSlot({ root: 'knowledge', dir: root }, sourcePath);
  const destination = await openKnowledgeFileSlot({ root: 'knowledge', dir: root }, targetPath);
  try {
    const sourceFile = `${source.directoryPath}/${source.name}`;
    const handle = await open(
      sourceFile,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    try {
      if (!(await handle.stat()).isFile()) throw new Error('source must be a regular file');
    } finally {
      await handle.close();
    }
    await link(sourceFile, `${destination.directoryPath}/${destination.name}`);
    await unlink(sourceFile);
    const movedExtraction = await moveKnowledgeExtraction(root, sourcePath, root, targetPath);
    if (!movedExtraction) await extractKnowledgeFile(root, targetPath);
    return { path: targetPath };
  } finally {
    await destination.close();
    await source.close();
  }
}

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
  const folder = sourceFolder(input.destination);
  const destination = sessionFilePath(join(root, folder), checkedPath(input.path));
  await ensureSourceDirectory(root, dirname(`${folder}/${destination.rel}`));
  // The destination folder is managed by Verity; refuse symlinked parents even
  // if one was introduced outside the explorer after the layout was created.
  await assertSessionRealPath(root, await realpath(dirname(destination.abs)));
  const path = await ingestKnowledgeBytes(root, `${folder}/${destination.rel}`, bytes);
  return { path, size: bytes.length };
}
