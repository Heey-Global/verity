import type { Conductor } from '@verity/session';
import { PROJECT_MEMORY_MAX_CHARS } from '@verity/store';
import { type FastifyInstance, type FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { createWriteStream, constants as fsConstants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  statfs,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DOCUMENT_SESSION_DIRECTORY,
  documentViewForSession,
  documentWorkspace,
  isDocumentWorkspace,
} from './document-workspace.js';
import './fastify-augmentation.js';
import {
  extractKnowledgeFile,
  knowledgeExtractionPath,
  moveKnowledgeExtraction,
  removeKnowledgeExtraction,
} from './knowledge-file-ingest.js';
import {
  ensureProjectKnowledge,
  ensureSharedKnowledge,
  KNOWLEDGE_INSIGHTS_DIR,
} from './knowledge-folder.js';
import { acquireKnowledgeMutationLock } from './knowledge-mutation-lock.js';
import { markProjectOverviewAuthoritative } from './project-overview-file.js';
import { projectClonePath } from './provisioner.js';
import { renameWorktreeFile } from './rename-worktree-file.js';
import type { ServerDeps } from './server-deps.js';
import {
  excludeFileHistoryFromGit,
  pruneFileHistory,
  recoverFileHistory,
  sessionFileHistory,
} from './session-file-history.js';
import { registerSessionFileRoutes } from './session-file-routes.js';
import { fileVersion, FileWriteError, writeSessionText } from './session-file-write.js';
import type { SessionFileRootName } from './session-files.js';
import {
  assertSessionRealPath,
  attachmentDisposition,
  contentTypeForDownload,
  hiddenSessionFileNames,
  isManagedKnowledgePath,
  isProbablyText,
  ManagedKnowledgePathError,
  normalizeSessionRelativePath,
  openKnowledgeFileSlot,
  sessionFilePath,
  toSessionFileEntry,
} from './session-files.js';

class SessionFileTooLargeError extends Error {}

const MAX_SESSION_DIRECTORY_ENTRIES = 1_000;

const MAX_SESSION_TEXT_FILE_BYTES = 1_000_000;

const MAX_SESSION_DOWNLOAD_BYTES = 50_000_000;

const MAX_SESSION_UPLOAD_BYTES = 250_000_000;

/** Map an {@link openKnowledgeFileSlot} rejection onto the explorer's status
 *  codes, keeping "you may not" (400) apart from "it is not there" (404). */
function knowledgeSlotFailure(reply: FastifyReply, error: unknown): { error: string } {
  if (error instanceof ManagedKnowledgePathError) {
    reply.code(400);
    return { error: error.message };
  }
  if (
    (error instanceof Error && error.message === 'invalid path') ||
    ['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
  ) {
    reply.code(400);
    return { error: 'invalid path' };
  }
  reply.code(404);
  return { error: 'path not found' };
}
export function registerServerSessionFiles(
  app: FastifyInstance,
  deps: Pick<ServerDeps, 'eventStore' | 'dataRoot' | 'projectCloneRoot'>,
  conductor: Conductor,
) {
  const fileStorageRoot = (root: { root: SessionFileRootName; dir: string }) =>
    root.root === 'documents' || root.root === 'sources' ? dirname(root.dir) : root.dir;

  const extractionArgs = (
    root: { root: SessionFileRootName; dir: string },
    path: string,
  ): [string, string] => [
    fileStorageRoot(root),
    root.root === 'documents' || root.root === 'sources' ? `${basename(root.dir)}/${path}` : path,
  ];

  registerSessionFileRoutes(app, {
    documentStatus: async (id) => {
      const session = await deps.eventStore.getSession(id);
      if (!session?.projectId || !deps.dataRoot) return undefined;
      const view = documentViewForSession(session);
      if (!view) return undefined;
      const running = conductor.isBusy(id);
      try {
        return {
          running,
          pending: await documentWorkspace(
            deps.dataRoot,
            session.projectId,
            view,
          ).hasPendingChanges(),
        };
      } catch {
        // A file may still be changing during a live turn; never label it published.
        return { running, pending: true };
      }
    },
    workspaceKind: async (id) =>
      isDocumentWorkspace((await deps.eventStore.getSession(id))?.worktree ?? '')
        ? 'documents'
        : 'code',
    // A knowledge root is created on first browse rather than only at
    // provisioning: the folder is the source of truth (ADR 0022 D1), so an
    // explorer that can show it is the shortest path to one that exists.
    resolveRoot: async (id, root) => {
      const session = await deps.eventStore.getSession(id);
      if (!session) return undefined;
      if (root === 'worktree') return session.worktree;
      if (deps.dataRoot === undefined) return undefined;
      if (root === 'shared') return ensureSharedKnowledge(deps.dataRoot);
      if (session.projectId === null) return undefined;
      const projectRoot = await ensureProjectKnowledge(deps.dataRoot, session.projectId);
      if (root === 'documents') return join(projectRoot, 'insights');
      if (root === 'sources') return join(projectRoot, 'sources');
      if (root === 'drafts') {
        const project = await deps.eventStore.getProject(session.projectId);
        if (!project || !deps.projectCloneRoot) return undefined;
        const drafts = join(
          projectClonePath(deps.projectCloneRoot, project),
          DOCUMENT_SESSION_DIRECTORY,
        );
        await mkdir(drafts, { recursive: true });
        return drafts;
      }
      return projectRoot;
    },
    list: async (reply, root, path) => {
      let target: { abs: string; rel: string };
      try {
        target = sessionFilePath(root.dir, path);
      } catch {
        reply.code(400);
        return { error: 'invalid path' };
      }
      let directoryHandle;
      try {
        directoryHandle = await open(
          target.abs,
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
        );
        await assertSessionRealPath(
          root.dir,
          await realpath(`/proc/self/fd/${String(directoryHandle.fd)}`),
        );
      } catch (error) {
        await directoryHandle?.close().catch(() => undefined);
        if (error instanceof Error && error.message === 'invalid path') {
          reply.code(400);
          return { error: 'invalid path' };
        }
        reply.code(404);
        return { error: 'path not found' };
      }

      try {
        const release = await acquireKnowledgeMutationLock(fileStorageRoot(root));
        try {
          await recoverFileHistory(`/proc/self/fd/${directoryHandle.fd}`);
        } finally {
          release();
        }
        const descriptorPath = `/proc/self/fd/${String(directoryHandle.fd)}`;
        const dirents = await readdir(descriptorPath, { withFileTypes: true });
        const hidden = hiddenSessionFileNames(root.root, target.rel);
        const visible = dirents.filter((entry) => !hidden.includes(entry.name));
        const entries = await Promise.all(
          visible.slice(0, MAX_SESSION_DIRECTORY_ENTRIES).map(async (entry) => {
            const rel = normalizeSessionRelativePath(
              [target.rel, entry.name].filter(Boolean).join('/'),
            );
            const childStats = await lstat(resolve(descriptorPath, entry.name));
            return toSessionFileEntry(rel, entry.name, childStats);
          }),
        );
        entries.sort((a, b) => {
          if (a.kind === 'directory' && b.kind !== 'directory') return -1;
          if (a.kind !== 'directory' && b.kind === 'directory') return 1;
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
        return {
          root: root.root,
          path: target.rel,
          entries,
          truncated: visible.length > MAX_SESSION_DIRECTORY_ENTRIES,
        };
      } finally {
        await directoryHandle.close();
      }
    },
    upload: async (request, reply, root, query) => {
      const declaredSize = Number(request.headers['content-length']);
      if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
        reply.code(411);
        return { error: 'file size is required' };
      }
      if (declaredSize > MAX_SESSION_UPLOAD_BYTES) {
        reply.code(413);
        return { error: 'file exceeds the 250 MB upload limit' };
      }
      let directory: { abs: string; rel: string };
      let target: { abs: string; rel: string };
      try {
        directory = sessionFilePath(root.dir, query.path);
        target = sessionFilePath(
          root.dir,
          [directory.rel, query.fileName].filter(Boolean).join('/'),
        );
        if (root.root !== 'worktree' && isManagedKnowledgePath(root.root, target.rel)) {
          reply.code(400);
          return { error: 'this path is managed by Verity' };
        }
        if (
          root.root === 'knowledge' &&
          target.rel === 'overview.md' &&
          declaredSize > PROJECT_MEMORY_MAX_CHARS * 4
        ) {
          reply.code(413);
          return { error: 'overview.md exceeds the project overview limit' };
        }
        await assertSessionRealPath(root.dir, directory.abs);
        const directoryStats = await lstat(directory.abs);
        if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
          reply.code(400);
          return { error: 'path is not a directory' };
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'invalid path') {
          reply.code(400);
          return { error: 'invalid path' };
        }
        reply.code(404);
        return { error: 'path not found' };
      }

      const directoryHandle = await open(
        directory.abs,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
      const descriptorPath = `/proc/self/fd/${String(directoryHandle.fd)}`;
      const temporaryPath = `${descriptorPath}/.verity-upload-${randomUUID()}`;
      const destinationPath = `${descriptorPath}/${query.fileName}`;
      try {
        const openedDirectoryReal = await realpath(descriptorPath);
        await assertSessionRealPath(root.dir, openedDirectoryReal);
        const filesystem = await statfs(descriptorPath);
        const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
        const reserveBytes = Math.min(256_000_000, Math.floor(availableBytes * 0.1));
        if (declaredSize > availableBytes - reserveBytes) {
          reply.code(507);
          return { error: 'not enough free space to upload this file' };
        }
        // Resolve through the stable open directory descriptor. Even if an agent
        // concurrently renames the directory and replaces its old path with a
        // symlink, this still writes to the originally validated directory inode.
        let receivedBytes = 0;
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            receivedBytes += chunk.length;
            callback(
              receivedBytes > declaredSize
                ? new SessionFileTooLargeError('uploaded bytes exceed the declared Content-Length')
                : undefined,
              chunk,
            );
          },
        });
        await pipeline(
          request.body as NodeJS.ReadableStream,
          limiter,
          createWriteStream(temporaryPath, { flags: 'wx' }),
        );
        const uploaded = await lstat(temporaryPath);
        if (
          root.root === 'knowledge' &&
          target.rel === 'overview.md' &&
          (await readFile(temporaryPath, 'utf8')).length > PROJECT_MEMORY_MAX_CHARS
        ) {
          await unlink(temporaryPath);
          reply.code(413);
          return { error: 'overview.md exceeds the project overview limit' };
        }
        const releaseMutation = await acquireKnowledgeMutationLock(fileStorageRoot(root));
        try {
          await link(temporaryPath, destinationPath);
        } finally {
          releaseMutation?.();
        }
        await unlink(temporaryPath);
        if (root.root === 'knowledge' && target.rel === 'overview.md')
          await markProjectOverviewAuthoritative(root.dir);
        if (root.root !== 'worktree')
          await extractKnowledgeFile(...extractionArgs(root, target.rel));
        return { path: target.rel, size: Number(uploaded.size) };
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        if (error instanceof SessionFileTooLargeError) {
          reply.code(413);
          return { error: error.message };
        }
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code?: unknown }).code === 'EEXIST'
        ) {
          reply.code(409);
          return { error: `"${query.fileName}" already exists` };
        }
        throw error;
      } finally {
        await directoryHandle.close();
      }
    },
    content: async (reply, root, path) => {
      let target: { abs: string; rel: string };
      try {
        target = sessionFilePath(root.dir, path);
      } catch {
        reply.code(400);
        return { error: 'invalid path' };
      }
      let fileHandle;
      const editablePath = !isManagedKnowledgePath(root.root, target.rel);
      const release = editablePath
        ? await acquireKnowledgeMutationLock(fileStorageRoot(root))
        : () => {};
      try {
        if (editablePath) {
          let slot;
          try {
            slot = await openKnowledgeFileSlot(root, path);
            await recoverFileHistory(slot.directoryPath);
          } finally {
            await slot?.close();
          }
        }
        fileHandle = await open(target.abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        await assertSessionRealPath(
          root.dir,
          await realpath(`/proc/self/fd/${String(fileHandle.fd)}`),
        );
      } catch (error) {
        await fileHandle?.close().catch(() => undefined);
        if (
          (error instanceof Error && error.message === 'invalid path') ||
          ['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
        ) {
          reply.code(400);
          return { error: 'invalid path' };
        }
        reply.code(404);
        return { error: 'file not found' };
      } finally {
        release();
      }
      try {
        const stats = await fileHandle.stat();
        if (!stats.isFile()) {
          reply.code(404);
          return { error: 'file not found' };
        }
        const extractedBytes =
          root.root === 'worktree'
            ? undefined
            : await readFile(knowledgeExtractionPath(...extractionArgs(root, target.rel))).catch(
                () => undefined,
              );
        if (stats.size > MAX_SESSION_TEXT_FILE_BYTES) {
          if (
            extractedBytes !== undefined &&
            extractedBytes.length <= MAX_SESSION_TEXT_FILE_BYTES &&
            isProbablyText(extractedBytes)
          ) {
            return {
              path: target.rel,
              content: extractedBytes.toString('utf8'),
              size: extractedBytes.length,
              editable: false,
            };
          }
          reply.code(413);
          return { error: 'file is too large for text preview' };
        }
        const bytes = await fileHandle.readFile();
        if (!isProbablyText(bytes)) {
          if (
            extractedBytes !== undefined &&
            extractedBytes.length <= MAX_SESSION_TEXT_FILE_BYTES &&
            isProbablyText(extractedBytes)
          ) {
            return {
              path: target.rel,
              content: extractedBytes.toString('utf8'),
              size: extractedBytes.length,
              editable: false,
            };
          }
          reply.code(415);
          return { error: 'file is not a text file' };
        }
        return {
          path: target.rel,
          content: bytes.toString('utf8'),
          size: stats.size,
          version: fileVersion(bytes),
          editable:
            root.root !== 'drafts' &&
            root.root !== 'sources' &&
            !isManagedKnowledgePath(root.root, target.rel),
        };
      } finally {
        await fileHandle.close();
      }
    },
    history: async (reply, root, path, version) => {
      let slot;
      const release = await acquireKnowledgeMutationLock(fileStorageRoot(root));
      try {
        slot = await openKnowledgeFileSlot(root, path);
        await recoverFileHistory(slot.directoryPath);
        if (!version) {
          await pruneFileHistory(slot.directoryPath, slot.name).catch((error: unknown) => {
            app.log.warn(
              { err: error },
              'File history cleanup failed; retained versions remain available',
            );
          });
        }
        return await sessionFileHistory(slot.directoryPath, slot.name, version);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reply.code(404);
          return { error: 'version not found' };
        }
        return knowledgeSlotFailure(reply, error);
      } finally {
        await slot?.close();
        release();
      }
    },
    write: async (reply, root, body) => {
      let slot;
      try {
        slot = await openKnowledgeFileSlot(root, body.path);
      } catch (error) {
        return knowledgeSlotFailure(reply, error);
      }
      const release = await acquireKnowledgeMutationLock(fileStorageRoot(root));
      try {
        if (
          root.root === 'knowledge' &&
          slot.rel === 'overview.md' &&
          body.content.length > PROJECT_MEMORY_MAX_CHARS
        ) {
          reply.code(413);
          return { error: 'overview.md exceeds the project overview limit' };
        }
        if (root.root === 'worktree' && !isDocumentWorkspace(root.dir))
          await excludeFileHistoryFromGit(root.dir);
        const creationMode =
          root.root === 'knowledge' && slot.rel.startsWith(`${KNOWLEDGE_INSIGHTS_DIR}/`)
            ? 0o666
            : 0o644;
        const saved = await writeSessionText(
          slot,
          body.content,
          body.expectedVersion,
          creationMode,
        );
        let warning: string | undefined;
        const updates: Array<() => Promise<unknown>> = [];
        if (root.root === 'knowledge' && slot.rel === 'overview.md')
          updates.push(() => markProjectOverviewAuthoritative(root.dir));
        if (root.root !== 'worktree')
          updates.push(() => extractKnowledgeFile(...extractionArgs(root, slot.rel)));
        for (const update of updates) {
          try {
            await update();
          } catch (err) {
            app.log.warn(
              { err, path: slot.rel, root: root.root },
              'saved file Knowledge refresh failed',
            );
            warning = 'The file was saved. Knowledge search and context may be out of date.';
          }
        }
        return warning ? { ...saved, warning } : saved;
      } catch (error) {
        if (error instanceof FileWriteError) {
          reply.code(error.status);
          return { error: error.message };
        }
        throw error;
      } finally {
        release();
        await slot.close();
      }
    },
    download: async (reply, root, path) => {
      let target: { abs: string; rel: string };
      try {
        target = sessionFilePath(root.dir, path);
      } catch {
        reply.code(400);
        return { error: 'invalid path' };
      }
      let fileHandle;
      try {
        fileHandle = await open(target.abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        await assertSessionRealPath(
          root.dir,
          await realpath(`/proc/self/fd/${String(fileHandle.fd)}`),
        );
      } catch (error) {
        await fileHandle?.close().catch(() => undefined);
        if (error instanceof Error && error.message === 'invalid path') {
          reply.code(400);
          return { error: 'invalid path' };
        }
        reply.code(404);
        return { error: 'file not found' };
      }
      try {
        const stats = await fileHandle.stat();
        if (!stats.isFile()) {
          reply.code(404);
          return { error: 'file not found' };
        }
        if (stats.size > MAX_SESSION_DOWNLOAD_BYTES) {
          reply.code(413);
          return { error: 'file is too large to download' };
        }
        const name = basename(target.rel) || 'download';
        // Read through the already validated descriptor: an agent may rename or replace
        // the original path, but it cannot redirect this read outside the worktree.
        const body = await fileHandle.readFile();
        reply
          .header('Content-Type', contentTypeForDownload(name))
          .header('Content-Length', String(body.byteLength))
          .header('Content-Disposition', attachmentDisposition(name));
        return body;
      } finally {
        await fileHandle.close();
      }
    },
    remove: async (reply, root, path) => {
      let file;
      try {
        file = await openKnowledgeFileSlot(root, path);
      } catch (error) {
        return knowledgeSlotFailure(reply, error);
      }
      try {
        const releaseMutation = await acquireKnowledgeMutationLock(fileStorageRoot(root));
        try {
          const stats = await lstat(`${file.directoryPath}/${file.name}`).catch(() => undefined);
          if (stats === undefined) {
            reply.code(404);
            return { error: 'file not found' };
          }
          if (!stats.isFile()) {
            reply.code(400);
            return { error: 'only files can be deleted' };
          }
          await unlink(`${file.directoryPath}/${file.name}`);
          if (root.root === 'knowledge' && file.rel === 'overview.md')
            await markProjectOverviewAuthoritative(root.dir);
          if (root.root !== 'worktree')
            await removeKnowledgeExtraction(...extractionArgs(root, file.rel));
          return { path: file.rel, deleted: true };
        } finally {
          releaseMutation?.();
        }
      } finally {
        await file.close();
      }
    },
    move: async (reply, fromRoot, toRoot, body) => {
      let source;
      let destination;
      try {
        source = await openKnowledgeFileSlot(fromRoot, body.path);
        destination = await openKnowledgeFileSlot(
          toRoot,
          [body.toPath, body.toFileName ?? basename(source.rel)].filter(Boolean).join('/'),
        );
      } catch (error) {
        await source?.close();
        return knowledgeSlotFailure(reply, error);
      }
      const sourcePath = `${source.directoryPath}/${source.name}`;
      const destinationPath = `${destination.directoryPath}/${destination.name}`;
      const releases: Array<() => void> = [];
      // Acquire both roots in a stable order so opposite moves cannot deadlock.
      for (const dir of [...new Set([fileStorageRoot(fromRoot), fileStorageRoot(toRoot)])].sort()) {
        releases.push(await acquireKnowledgeMutationLock(dir));
      }
      try {
        const stats = await lstat(sourcePath).catch(() => undefined);
        if (stats === undefined) {
          reply.code(404);
          return { error: 'file not found' };
        }
        if (!stats.isFile()) {
          reply.code(400);
          return { error: 'only files can be moved' };
        }
        if (
          toRoot.root === 'knowledge' &&
          destination.rel === 'overview.md' &&
          (stats.size > PROJECT_MEMORY_MAX_CHARS * 4 ||
            (await readFile(sourcePath, 'utf8')).length > PROJECT_MEMORY_MAX_CHARS)
        ) {
          reply.code(413);
          return { error: 'overview.md exceeds the project overview limit' };
        }
        // Link-then-unlink rather than rename: `rename` would silently replace an
        // existing destination, and a move between the project folder and the
        // shared one is a scope change (ADR 0022 D1) — the one place where
        // overwriting somebody else's file must fail loudly. Both roots live
        // under the same data root, so the hard link always resolves. A rename
        // inside the worktree stays on one filesystem too, and must not replace
        // a file the agent wrote under the new name either.
        if (fromRoot.root === 'worktree') {
          await renameWorktreeFile(sourcePath, destinationPath);
        } else {
          await link(sourcePath, destinationPath);
          await unlink(sourcePath);
        }
        if (fromRoot.root === 'knowledge' && source.rel === 'overview.md')
          await markProjectOverviewAuthoritative(fromRoot.dir);
        if (toRoot.root === 'knowledge' && destination.rel === 'overview.md')
          await markProjectOverviewAuthoritative(toRoot.dir);
        // The worktree keeps no extracted-text mirror; only knowledge files carry one.
        if (toRoot.root !== 'worktree') {
          const movedExtraction = await moveKnowledgeExtraction(
            ...extractionArgs(fromRoot, source.rel),
            ...extractionArgs(toRoot, destination.rel),
          );
          if (!movedExtraction)
            await extractKnowledgeFile(...extractionArgs(toRoot, destination.rel));
        }
        return { path: destination.rel, root: toRoot.root };
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code?: unknown }).code === 'EEXIST'
        ) {
          reply.code(409);
          return { error: `"${destination.name}" already exists` };
        }
        throw error;
      } finally {
        for (const release of releases.reverse()) release();
        await source.close();
        await destination.close();
      }
    },
  });
}
