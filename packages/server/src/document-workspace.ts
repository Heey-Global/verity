import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, unlink, link, mkdtemp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { acquireKnowledgeMutationLock } from './knowledge-mutation-lock.js';
import { FILE_HISTORY_DIR, openFileHistory } from './session-file-history.js';

/** Server-owned state must be outside every writable agent mount. */
type Versions = Record<string, string>;
interface State {
  version: 1;
  files: Versions;
}
interface Intent {
  path: string;
  before: string | null;
  after: string | null;
  blob?: string;
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const ignored = new Set([FILE_HISTORY_DIR, '.git']);
const oversizedVersion = 'snapshot-too-large';
const isOversized = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === 'DOCUMENT_SNAPSHOT_TOO_LARGE';

async function durableWrite(path: string, bytes: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

/** Walk through pinned, no-follow directory descriptors; agent symlinks cannot
 * redirect a snapshot or a refresh outside the selected document root. */
async function parentSlot(root: string, path: string, create: boolean) {
  const parts = path.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.includes('\\') || p.includes('\0')))
    throw new Error('invalid document path');
  let directory = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (const part of parts.slice(0, -1)) {
      const next = `/proc/self/fd/${directory.fd}/${part}`;
      if (create)
        await mkdir(next).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      const child = await open(
        next,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await directory.close();
      directory = child;
    }
    return {
      directory,
      path: `/proc/self/fd/${directory.fd}/${parts.at(-1)!}`,
      name: parts.at(-1)!,
    };
  } catch (error) {
    await directory.close();
    throw error;
  }
}

async function readDocument(root: string, path: string): Promise<Buffer | undefined> {
  let slot;
  try {
    slot = await parentSlot(root, path, false);
    const file = await open(
      slot.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await file.stat();
      if (!before.isFile())
        throw Object.assign(new Error(`document is not a regular file: ${path}`), {
          code: 'EISDIR',
        });
      // Bound one snapshot; large files stay visible in the view rather than
      // allowing an agent to exhaust the server's memory during publication.
      if (before.size > 64 * 1024 * 1024)
        throw Object.assign(new Error(`document exceeds snapshot limit: ${path}`), {
          code: 'DOCUMENT_SNAPSHOT_TOO_LARGE',
        });
      // Read at most the observed size plus one byte. A growing file must never
      // make readFile allocate beyond the snapshot limit before we can reject it.
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const bytes = buffer.subarray(0, length);
      const after = await file.stat();
      if (
        length !== before.size ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error(`document is still being written: ${path}`);
      return bytes;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  } finally {
    await slot?.directory.close();
  }
}

async function inventory(root: string): Promise<Versions> {
  const result: Versions = Object.create(null) as Versions;
  async function walk(path: string): Promise<void> {
    const slot = path ? await parentSlot(root, `${path}/placeholder`, false) : undefined;
    const handle =
      slot?.directory ??
      (await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    try {
      const entries = await readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true });
      for (const entry of entries) {
        if (ignored.has(entry.name)) continue;
        const rel = path ? `${path}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw new Error(`document symlinks are not supported: ${rel}`);
        if (entry.isDirectory()) await walk(rel);
        else {
          try {
            const bytes = await readDocument(root, rel);
            if (bytes) result[rel] = digest(bytes);
          } catch (error) {
            if (!isOversized(error)) throw error;
            // Keep an entry: omission would misinterpret an oversized edit as deletion.
            result[rel] = oversizedVersion;
          }
        }
      }
    } finally {
      await handle.close();
    }
  }
  await walk('');
  return result;
}

/** One private filesystem view of Documents. No Git is involved. Publication
 * uses the SAME knowledge-root lock as Explorer saves, uploads, moves and deletes. */
export class DocumentWorkspace {
  constructor(
    readonly documents: string,
    readonly view: string,
    readonly stateRoot: string,
  ) {}

  private async state(): Promise<State> {
    try {
      const state = JSON.parse(await readFile(join(this.stateRoot, 'state.json'), 'utf8')) as State;
      if (state.version !== 1 || !state.files) throw new Error('invalid document workspace state');
      state.files = Object.assign(Object.create(null) as Versions, state.files);
      return state;
    } catch (error) {
      if (missing(error)) return { version: 1, files: Object.create(null) as Versions };
      throw error;
    }
  }
  private async save(state: State) {
    await durableWrite(join(this.stateRoot, 'state.json'), JSON.stringify(state));
  }

  private async replace(root: string, path: string, bytes: Buffer | undefined) {
    const slot = await parentSlot(root, path, bytes !== undefined);
    try {
      if (root === this.view) {
        const previous = await readDocument(root, path);
        if (previous !== undefined) {
          const history = await openFileHistory(`/proc/self/fd/${slot.directory.fd}`);
          try {
            const record = await mkdtemp(`/proc/self/fd/${history.fd}/save-`);
            await durableWrite(join(record, 'name'), slot.name);
            await durableWrite(join(record, 'snapshot'), previous);
            // Retain the inode as well: a detached writer can save through its
            // open descriptor after refresh replaced the visible pathname.
            await link(slot.path, join(record, 'original'));
            await durableWrite(join(record, 'complete'), '');
          } finally {
            await history.close();
          }
        }
      }
      if (bytes === undefined) {
        await unlink(slot.path).catch((e: unknown) => {
          if (!missing(e)) throw e;
        });
      } else {
        const temp = `/proc/self/fd/${slot.directory.fd}/.document-${randomUUID()}`;
        const output = await open(temp, 'wx', 0o644);
        try {
          await output.writeFile(bytes);
          await output.sync();
        } finally {
          await output.close();
        }
        await rename(temp, slot.path);
      }
      await slot.directory.sync();
    } finally {
      await slot.directory.close();
    }
  }

  /** Resolve an interrupted publication before another view or Explorer can write. */
  private async recover(state: State): Promise<void> {
    let intent: Intent;
    try {
      intent = JSON.parse(await readFile(join(this.stateRoot, 'intent.json'), 'utf8')) as Intent;
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    let current: Buffer | undefined;
    try {
      current = await readDocument(this.documents, intent.path);
    } catch (error) {
      if (
        !isOversized(error) &&
        !['EISDIR', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
      )
        throw error;
      // Another writer replaced the path or an ancestor after the intent was
      // recorded. Keep the old base so publication can retain a conflict.
      await unlink(join(this.stateRoot, 'intent.json'));
      return;
    }
    const currentVersion = current === undefined ? null : digest(current);
    if (currentVersion === intent.after) {
      if (intent.after === null) delete state.files[intent.path];
      else state.files[intent.path] = intent.after;
      await this.save(state);
    }
    // If publication did not happen, the unchanged view still carries the edit.
    // If another writer intervened, publish() will produce a conflict copy.
    await unlink(join(this.stateRoot, 'intent.json'));
  }

  async hasPendingChanges(): Promise<boolean> {
    const state = await this.state();
    const local = await inventory(this.view);
    return [...new Set([...Object.keys(state.files), ...Object.keys(local)])].some(
      (path) => (state.files[path] ?? null) !== (local[path] ?? null),
    );
  }

  async prepare(): Promise<void> {
    await mkdir(this.view, { recursive: true });
    await mkdir(this.documents, { recursive: true });
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    const release = await acquireKnowledgeMutationLock(dirname(this.documents));
    try {
      const state = await this.state();
      await this.recover(state);
      const local = await inventory(this.view);
      const current = await inventory(this.documents);
      for (const path of new Set([...Object.keys(state.files), ...Object.keys(current)])) {
        if (local[path] === oversizedVersion || current[path] === oversizedVersion) continue;
        if ((local[path] ?? null) !== (state.files[path] ?? null)) continue;
        if ((local[path] ?? null) === (current[path] ?? null)) continue;
        try {
          const actual = await readDocument(this.view, path);
          if ((actual === undefined ? null : digest(actual)) !== (local[path] ?? null)) continue;
          const bytes = await readDocument(this.documents, path);
          await this.replace(this.view, path, bytes);
          if (bytes === undefined) delete state.files[path];
          else state.files[path] = digest(bytes);
          await this.save(state);
        } catch (error) {
          if (
            !isOversized(error) &&
            !['EISDIR', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
          )
            throw error;
          // Retain both trees and their bases on a structural collision. Refresh
          // must not recursively erase a working directory or block future turns.
        }
      }
      await this.save(state);
    } finally {
      release();
    }
  }

  /** Transfer outstanding edits explicitly; published source documents stay in
   * their original project. A unique namespace avoids overwriting target files. */
  async transferPending(target: DocumentWorkspace, prefix: string): Promise<string[]> {
    const state = await this.state();
    const before = await inventory(this.view);
    const copied: string[] = [];
    for (const path of new Set([...Object.keys(state.files), ...Object.keys(before)])) {
      if ((state.files[path] ?? null) === (before[path] ?? null)) continue;
      const bytes = await readDocument(this.view, path);
      const destination =
        bytes === undefined ? `${prefix}/${path}.deletion.json` : `${prefix}/${path}`;
      const proposal = bytes ?? Buffer.from(JSON.stringify({ deletedPath: path }));
      const existing = await readDocument(target.view, destination);
      if (existing !== undefined && !existing.equals(proposal))
        throw new Error('Transferred document already changed; both working copies were retained');
      if (existing === undefined) await target.replace(target.view, destination, proposal);
      copied.push(destination);
    }
    if (JSON.stringify(before) !== JSON.stringify(await inventory(this.view)))
      throw new Error('Source documents changed during transfer; retry after writers have stopped');
    return copied;
  }

  async publish(): Promise<{ changed: string[]; conflicts: string[] }> {
    const release = await acquireKnowledgeMutationLock(dirname(this.documents));
    const result = { changed: [] as string[], conflicts: [] as string[] };
    try {
      const state = await this.state();
      await this.recover(state);
      const local = await inventory(this.view);
      for (const path of new Set([...Object.keys(state.files), ...Object.keys(local)])) {
        const base = state.files[path] ?? null;
        const next = local[path] ?? null;
        if (next === oversizedVersion || base === next) continue;
        const bytes = await readDocument(this.view, path);
        if ((bytes === undefined ? null : digest(bytes)) !== next)
          throw new Error(`document changed during publication: ${path}`);
        let current: Buffer | undefined;
        try {
          current = await readDocument(this.documents, path);
        } catch (error) {
          if (isOversized(error)) continue;
          if (!['ENOTDIR', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
            throw error;
          // File/directory collisions are conflicts, never recursive replacements.
          current = Buffer.from('directory conflict');
        }
        const head = current === undefined ? null : digest(current);
        if (head === next) {
          if (next === null) delete state.files[path];
          else state.files[path] = next;
          await this.save(state);
          continue;
        }
        if (head !== base) {
          const id = digest(Buffer.from(JSON.stringify([this.view, path, base, next, head]))).slice(
            0,
            24,
          );
          const conflict = `Conflicts/${id}`;
          // Conflict artifacts are additive and deterministic, including deletion
          // proposals; retries never choose an existing user's filename.
          const note = {
            path,
            workspace: this.view,
            base,
            current: head,
            proposed: next,
            deletion: next === null,
          };
          const recordPath = `${conflict}/conflict.json`;
          const prior = await readDocument(this.documents, recordPath);
          if (prior && prior.toString() !== JSON.stringify(note))
            throw new Error('conflict record collision');
          if (!prior) {
            if (bytes)
              await this.replace(
                this.documents,
                `${conflict}/proposed/${path.split('/').at(-1)!}`,
                bytes,
              );
            await this.replace(this.documents, recordPath, Buffer.from(JSON.stringify(note)));
          }
          result.conflicts.push(recordPath);
          continue;
        }
        const slot = await parentSlot(this.documents, path, bytes !== undefined);
        try {
          // Use the Explorer history layout so text versions appear in its
          // existing Versions action. Binary snapshots are retained as well.
          if (current !== undefined) {
            const history = join(
              `/proc/self/fd/${slot.directory.fd}`,
              FILE_HISTORY_DIR,
              `save-${randomUUID().replaceAll('-', '')}`,
            );
            await mkdir(history, { recursive: true, mode: 0o700 });
            await durableWrite(join(history, 'name'), slot.name);
            await durableWrite(join(history, 'snapshot'), current);
            await durableWrite(join(history, 'complete'), '');
          }
        } finally {
          await slot.directory.close();
        }
        await durableWrite(
          join(this.stateRoot, 'intent.json'),
          JSON.stringify({ path, before: base, after: next } satisfies Intent),
        );
        await this.replace(this.documents, path, bytes);
        if (next === null) delete state.files[path];
        else state.files[path] = next;
        await this.save(state);
        await unlink(join(this.stateRoot, 'intent.json'));
        result.changed.push(path);
      }
      return result;
    } finally {
      release();
    }
  }
}

export const DOCUMENT_SESSION_DIRECTORY = '.verity-document-sessions';
export function isDocumentWorkspace(path: string): boolean {
  return path.split('/').includes(DOCUMENT_SESSION_DIRECTORY);
}

/** Code sessions keep Documents beside their Git worktrees. */
export function documentViewForSession(session: {
  sessionId: string;
  worktree: string;
}): string | undefined {
  if (isDocumentWorkspace(session.worktree)) return session.worktree;
  const segments = session.worktree.split('/');
  const index = segments.lastIndexOf('.verity-sessions');
  if (index < 0 || !/^[A-Za-z0-9_-]+$/.test(session.sessionId)) return undefined;
  return join(
    segments.slice(0, index).join('/') || '/',
    DOCUMENT_SESSION_DIRECTORY,
    `code-${session.sessionId}`,
  );
}

export function documentWorkspace(dataRoot: string, projectId: string, view: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error('invalid project id');
  return new DocumentWorkspace(
    join(dataRoot, 'knowledge', projectId, 'insights'),
    view,
    join(dataRoot, 'document-workspaces', projectId, digest(Buffer.from(view))),
  );
}

export function createDocumentWorkspaceProvisioner(
  dataRoot: string,
  projectId: string,
  workspaceRoot: string,
) {
  return {
    async add(name: string): Promise<string> {
      const segment = name.replace(/[^A-Za-z0-9_-]/g, '-');
      if (!segment) throw new Error('invalid document workspace name');
      const view = join(workspaceRoot, DOCUMENT_SESSION_DIRECTORY, segment);
      // A retry must not bind a second session to an existing writer's view.
      await mkdir(dirname(view), { recursive: true });
      await mkdir(view);
      await documentWorkspace(dataRoot, projectId, view).prepare();
      return view;
    },
    async remove(view: string): Promise<void> {
      if (!isDocumentWorkspace(view)) throw new Error('not a document workspace');
      const workspace = documentWorkspace(dataRoot, projectId, view);
      await workspace.publish();
      // Keep all files after deletion, including unresolved and late changes.
      // The workspace directory is deliberately not removed.
    },
  };
}
